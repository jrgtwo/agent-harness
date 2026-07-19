import { WebSocketServer, type WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { run, type ConsentFn, type ContextConfig, type InvokeClientTool } from '../agent/loop';
import { renderUiTagInstructions, type UiTagDef } from '../agent/uiTags';
import type { Message, ModelClient } from '../core/types';
import type { ToolRegistry } from '../agent/tools';
import type { Store } from '../store/store';
import { parseClientMessage, type ClientToolDecl, type ServerMessage } from './protocol';

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
  const wss = new WebSocketServer({ port: opts.port ?? 0, host: opts.host ?? '127.0.0.1' });

  wss.on('connection', (ws) => handleConnection(ws, opts, agents));

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

function handleConnection(ws: WebSocket, opts: HarnessServerOptions, agents: Map<string, Agent>): void {
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
          emit: (event) => send({ type: 'run.event', runId: msg.runId, event }),
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
