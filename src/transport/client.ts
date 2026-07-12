import type { AgentEvent } from '../core/events';
import type { ClientMessage, ClientToolDecl, ServerMessage } from './protocol';
import type { Message } from '../core/types';
import type { SessionInfo } from '../store/store';

/**
 * The thin client SDK an app uses to talk to the harness. In the browser it uses the global
 * WebSocket; in Node (tests, the /example testbed) pass a WebSocket implementation (e.g. `ws`).
 */

/** Structural minimum we need from a WebSocket — satisfied by both the browser and `ws`. */
interface MinimalSocket {
  send(data: string): void;
  close(): void;
  readyState: number;
  addEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (ev: any) => void): void;
}
type SocketCtor = new (url: string) => MinimalSocket;

export interface HarnessClientHandlers {
  onReady?: (agents: string[]) => void;
  onEvent?: (runId: string, event: AgentEvent) => void;
  onToolInvoke?: (req: { runId: string; callId: string; name: string; args: unknown }) => void;
  onSessions?: (sessions: SessionInfo[]) => void;
  onSessionMessages?: (sessionId: string, messages: Message[]) => void;
  onSessionDeleted?: (sessionId: string) => void;
  onError?: (err: { code: string; message: string; runId?: string }) => void;
}

export interface HarnessClientOptions {
  handlers?: HarnessClientHandlers;
  clientTools?: ClientToolDecl[];
  /** WebSocket implementation. Defaults to the global (browser / Node 22+). */
  WebSocketImpl?: SocketCtor;
}

export class HarnessClient {
  private ws?: MinimalSocket;
  private readonly url: string;
  private readonly token: string;
  private readonly handlers: HarnessClientHandlers;
  private readonly clientTools?: ClientToolDecl[];
  private readonly WS: SocketCtor;

  constructor(url: string, token: string, opts: HarnessClientOptions = {}) {
    this.url = url;
    this.token = token;
    this.handlers = opts.handlers ?? {};
    this.clientTools = opts.clientTools;
    this.WS = opts.WebSocketImpl ?? ((globalThis as any).WebSocket as SocketCtor);
  }

  /** Connect and complete the handshake. Resolves with the available agent names. */
  connect(): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const ws = new this.WS(this.url);
      this.ws = ws;
      ws.addEventListener('open', () => this.send({ type: 'hello', token: this.token, clientTools: this.clientTools }));
      ws.addEventListener('error', () => reject(new Error('websocket connection error')));
      ws.addEventListener('close', () => {});
      ws.addEventListener('message', (ev: any) => {
        let msg: ServerMessage;
        try {
          msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
        } catch {
          return;
        }
        if (msg.type === 'ready') {
          this.handlers.onReady?.(msg.agents);
          resolve(msg.agents);
          return;
        }
        this.dispatch(msg);
      });
    });
  }

  private dispatch(msg: ServerMessage): void {
    switch (msg.type) {
      case 'run.event':
        this.handlers.onEvent?.(msg.runId, msg.event);
        break;
      case 'tool.invoke':
        this.handlers.onToolInvoke?.(msg);
        break;
      case 'sessions':
        this.handlers.onSessions?.(msg.sessions);
        break;
      case 'session.messages':
        this.handlers.onSessionMessages?.(msg.sessionId, msg.messages);
        break;
      case 'session.deleted':
        this.handlers.onSessionDeleted?.(msg.sessionId);
        break;
      case 'error':
        this.handlers.onError?.(msg);
        break;
    }
  }

  private send(msg: ClientMessage): void {
    this.ws?.send(JSON.stringify(msg));
  }

  startRun(input: string, opts: { runId?: string; agent?: string; sessionId?: string } = {}): string {
    const runId = opts.runId ?? crypto.randomUUID();
    this.send({ type: 'run.start', runId, input, agent: opts.agent, sessionId: opts.sessionId });
    return runId;
  }

  decideConsent(runId: string, callId: string, allow: boolean): void {
    this.send({ type: 'consent.decision', runId, callId, allow });
  }

  respondTool(runId: string, callId: string, result?: unknown, error?: string): void {
    this.send({ type: 'tool.result', runId, callId, result, error });
  }

  cancel(runId: string): void {
    this.send({ type: 'run.cancel', runId });
  }

  listSessions(): void {
    this.send({ type: 'session.list' });
  }

  loadSession(sessionId: string): void {
    this.send({ type: 'session.load', sessionId });
  }

  deleteSession(sessionId: string): void {
    this.send({ type: 'session.delete', sessionId });
  }

  close(): void {
    this.ws?.close();
  }
}
