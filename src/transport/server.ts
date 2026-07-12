import { WebSocketServer, type WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { run, type ConsentFn, type ContextConfig } from '../agent/loop';
import type { Message, ModelClient } from '../core/types';
import type { ToolRegistry } from '../agent/tools';
import type { Store } from '../store/store';
import { parseClientMessage, type ServerMessage } from './protocol';

/** An agent = config over the shared harness: a prompt + a tool set (+ later, model/context). */
export interface Agent {
  name: string;
  systemPrompt: string;
  tools: ToolRegistry;
  /** Optional context management (budget/summary/tool-caps/live-state). */
  context?: ContextConfig;
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
  const pendingConsent = new Map<string, (allow: boolean) => void>();
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
          new Promise<boolean>((resolve) => pendingConsent.set(callId, resolve));

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
          systemPrompt: agent.systemPrompt,
          model: opts.model,
          tools: agent.tools,
          history,
          context: agent.context,
          emit: (event) => send({ type: 'run.event', runId: msg.runId, event }),
          requestConsent,
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
      case 'run.cancel': {
        activeRuns.get(msg.runId)?.abort();
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
      case 'hello':
        send({ type: 'error', code: 'already_authed', message: 'already connected' });
        return;
      // 'tool.result' — client-side tool responses; wired when client-side tools land.
    }
  });

  ws.on('close', () => {
    for (const controller of activeRuns.values()) controller.abort();
    pendingConsent.clear();
    activeRuns.clear();
  });
}
