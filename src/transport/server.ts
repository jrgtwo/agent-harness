import { WebSocketServer, type WebSocket } from 'ws';
import { appendFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { run, type ConsentFn, type ContextConfig, type InvokeClientTool } from '../agent/loop';
import { renderUiTagInstructions, type UiTagDef } from '../agent/uiTags';
import type { AgentEvent } from '../core/events';
import type { Message, ModelClient } from '../core/types';
import type { ToolRegistry } from '../agent/tools';
import type { Store } from '../store/store';
import { parseClientMessage, type ClientToolDecl, type ServerMessage } from './protocol';

// Opt-in debug trace: set HARNESS_DEBUG_LOG=<path> to append newline-delimited JSON of run/cache
// decisions. A no-op (and never throws) when unset — safe to leave in.
function debugLog(entry: Record<string, unknown>): void {
  const path = process.env.HARNESS_DEBUG_LOG;
  if (!path) return;
  try {
    appendFileSync(path, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n');
  } catch {
    /* debug logging must never break a run */
  }
}

/** An agent = config over the shared harness: a prompt + a tool set (+ later, model/context). */
export interface Agent {
  name: string;
  systemPrompt: string;
  tools: ToolRegistry;
  /** Optional context management (budget/summary/tool-caps/live-state). */
  context?: ContextConfig;
  /** Declarative UI tags the model may emit inline; the harness teaches + parses them (uiTags). */
  uiTags?: UiTagDef[];
}

export interface HarnessServerOptions {
  model: ModelClient;
  agents: Agent[];
  /** Local shared token an app must present on `hello`. Keeps random localhost pages out. */
  token: string;
  /** Optional persistence. When provided (and a run carries a sessionId), chat is multi-turn. */
  store?: Store;
  port?: number;
  host?: string;
}

export interface HarnessServerHandle {
  port: number;
  close(): Promise<void>;
}

/** Start the harness sidecar's WebSocket server. Resolves once it's listening. */
export function createHarnessServer(opts: HarnessServerOptions): Promise<HarnessServerHandle> {
  const agents = new Map(opts.agents.map((a) => [a.name, a]));
  // Per-server memoization of run results, keyed by a caller-supplied opaque cacheKey. Shared across
  // connections; unbounded (fine for a probe); resets when the process restarts.
  const runCache = new Map<string, { content: string; at: number }>();
  const wss = new WebSocketServer({ port: opts.port ?? 0, host: opts.host ?? '127.0.0.1' });

  wss.on('connection', (ws) => handleConnection(ws, opts, agents, runCache));

  return new Promise((resolve, reject) => {
    wss.on('error', reject);
    wss.on('listening', () => {
      const address = wss.address() as AddressInfo;
      resolve({
        port: address.port,
        close: () =>
          new Promise<void>((res) => {
            for (const client of wss.clients) client.terminate();
            wss.close(() => res());
          }),
      });
    });
  });
}

function handleConnection(
  ws: WebSocket,
  opts: HarnessServerOptions,
  agents: Map<string, Agent>,
  runCache: Map<string, { content: string; at: number }>,
): void {
  let authed = false;
  let clientTools: ClientToolDecl[] = [];
  // Connection-scoped consent policy: 'ask' round-trips every non-auto tool to the client (default);
  // 'allow' auto-approves them server-side (no round-trip). Set via a consent.policy message.
  let consentPolicy: 'ask' | 'allow' = 'ask';
  const pendingConsent = new Map<string, (allow: boolean) => void>();
  const pendingToolResults = new Map<string, (r: { result?: unknown; error?: string }) => void>();
  const activeRuns = new Map<string, AbortController>();

  const send = (msg: ServerMessage) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  ws.on('message', (data) => {
    let raw: unknown;
    try {
      raw = JSON.parse(data.toString());
    } catch {
      send({ type: 'error', code: 'bad_json', message: 'message was not valid JSON' });
      return;
    }

    // TEMP wire-truth debug: log the raw run.start exactly as it arrived (before parse). If cacheKey
    // is present here but null after parse → server/parse bug; if absent here → the client never sent it.
    if ((raw as { type?: unknown } | null)?.type === 'run.start') {
      debugLog({ ev: 'raw.run.start', hasCacheKeyOnWire: 'cacheKey' in (raw as object), raw });
    }

    const parsed = parseClientMessage(raw);
    if (!parsed.ok) {
      send({ type: 'error', code: 'bad_message', message: parsed.error });
      return;
    }
    const msg = parsed.value;

    if (!authed) {
      if (msg.type !== 'hello') {
        send({ type: 'error', code: 'unauthorized', message: 'send hello first' });
        return;
      }
      if (msg.token !== opts.token) {
        send({ type: 'error', code: 'unauthorized', message: 'invalid token' });
        ws.close();
        return;
      }
      authed = true;
      clientTools = msg.clientTools ?? [];
      send({ type: 'ready', agents: [...agents.keys()] });
      return;
    }

    switch (msg.type) {
      case 'run.start': {
        const emit = (event: AgentEvent) => send({ type: 'run.event', runId: msg.runId, event });
        debugLog({ ev: 'run.start', runId: msg.runId, agent: msg.agent ?? null, cacheKey: msg.cacheKey ?? null, ttl: msg.ttl ?? null, cacheSize: runCache.size });

        // Memoization: replay a fresh cached result without re-running the agent (no model, no tools,
        // no consent). Stale entries are dropped and fall through to a normal run.
        if (msg.cacheKey) {
          const hit = runCache.get(msg.cacheKey);
          // Fresh when no ttl (never expires) or strictly younger than ttl (so ttl:0 always re-runs).
          if (hit && (msg.ttl === undefined || Date.now() - hit.at < msg.ttl)) {
            debugLog({ ev: 'cache.hit', runId: msg.runId, cacheKey: msg.cacheKey, ageMs: Date.now() - hit.at });
            emit({ type: 'run.started', runId: msg.runId });
            if (hit.content) emit({ type: 'token', runId: msg.runId, text: hit.content });
            emit({ type: 'run.finished', runId: msg.runId, result: hit.content });
            return;
          }
          debugLog({ ev: hit ? 'cache.stale' : 'cache.miss', runId: msg.runId, cacheKey: msg.cacheKey });
          if (hit) runCache.delete(msg.cacheKey);
        }

        const agent = msg.agent ? agents.get(msg.agent) : agents.values().next().value;
        if (!agent) {
          send({ type: 'error', code: 'unknown_agent', message: `no agent "${msg.agent}"`, runId: msg.runId });
          return;
        }
        const controller = new AbortController();
        activeRuns.set(msg.runId, controller);

        const requestConsent: ConsentFn = ({ callId }) =>
          consentPolicy === 'allow'
            ? Promise.resolve(true)
            : new Promise<boolean>((resolve) => pendingConsent.set(callId, resolve));

        // Bridge a model tool-call out to the app's UI (client tool) and await its response.
        const invokeClientTool: InvokeClientTool = ({ runId, callId, name, args }) => {
          send({ type: 'tool.invoke', runId, callId, name, args });
          return new Promise((resolve) => pendingToolResults.set(callId, resolve));
        };

        // Load prior history for a persisted session; new messages get saved after the run.
        const store = opts.store;
        const sessionId = msg.sessionId;
        let history: Message[] = [];
        if (store && sessionId) {
          store.ensureSession(sessionId, msg.input.slice(0, 60), agent.name);
          history = store.getMessages(sessionId);
        }

        run({
          runId: msg.runId,
          input: msg.input,
          // Teach the model any declarative UI tags the agent declared, right in the system prompt.
          systemPrompt: agent.systemPrompt + renderUiTagInstructions(agent.uiTags ?? []),
          model: opts.model,
          tools: agent.tools,
          history,
          context: agent.context,
          emit,
          requestConsent,
          clientTools,
          invokeClientTool,
          signal: controller.signal,
        })
          .then((result) => {
            if (store && sessionId) {
              store.appendMessages(sessionId, result.newMessages);
              store.touchSession(sessionId);
            }
            // Memoize a successful, answered run under its cacheKey.
            if (msg.cacheKey) {
              const stored = result.stoppedReason === 'answered' && !!result.content;
              debugLog({
                ev: 'cache.store',
                runId: msg.runId,
                cacheKey: msg.cacheKey,
                stopReason: result.stoppedReason,
                stored,
                contentLen: result.content?.length ?? 0,
              });
              if (stored) runCache.set(msg.cacheKey, { content: result.content, at: Date.now() });
            }
          })
          .catch((err) =>
            send({
              type: 'error',
              code: 'run_failed',
              message: (err as Error)?.message ?? String(err),
              runId: msg.runId,
            }),
          )
          .finally(() => activeRuns.delete(msg.runId));
        return;
      }
      case 'consent.decision': {
        const resolve = pendingConsent.get(msg.callId);
        if (resolve) {
          pendingConsent.delete(msg.callId);
          resolve(msg.allow);
        }
        return;
      }
      case 'consent.policy': {
        consentPolicy = msg.mode;
        // Switching to 'allow' also clears the current backlog — resolve everything pending.
        if (msg.mode === 'allow') {
          for (const resolve of pendingConsent.values()) resolve(true);
          pendingConsent.clear();
        }
        return;
      }
      case 'run.cancel': {
        activeRuns.get(msg.runId)?.abort();
        return;
      }
      case 'run.cancelAll': {
        for (const controller of activeRuns.values()) controller.abort();
        return;
      }
      case 'session.list': {
        send({ type: 'sessions', sessions: opts.store?.listSessions() ?? [] });
        return;
      }
      case 'session.load': {
        send({
          type: 'session.messages',
          sessionId: msg.sessionId,
          messages: opts.store?.getMessages(msg.sessionId) ?? [],
        });
        return;
      }
      case 'session.delete': {
        opts.store?.deleteSession(msg.sessionId);
        send({ type: 'session.deleted', sessionId: msg.sessionId });
        return;
      }
      case 'tool.result': {
        const resolve = pendingToolResults.get(msg.callId);
        if (resolve) {
          pendingToolResults.delete(msg.callId);
          resolve({ result: msg.result, error: msg.error });
        }
        return;
      }
      case 'hello':
        send({ type: 'error', code: 'already_authed', message: 'already connected' });
        return;
    }
  });

  ws.on('close', () => {
    for (const controller of activeRuns.values()) controller.abort();
    // Unblock any in-flight client-tool invocation so its awaiting dispatch doesn't hang.
    for (const resolve of pendingToolResults.values()) resolve({ error: 'connection closed' });
    pendingConsent.clear();
    pendingToolResults.clear();
    activeRuns.clear();
  });
}
