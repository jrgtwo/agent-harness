import type { AgentEvent } from './events';

/**
 * The wire contract between an app and the harness sidecar. One WebSocket per connection;
 * every message is a typed JSON envelope. Everything is validated on receipt — malformed
 * input becomes a typed `error`, never a crash and never an executed action.
 */

/** Declaration of a client-side tool (handler lives in the app UI, invoked via RPC). */
export interface ClientToolDecl {
  name: string;
  description: string;
  params: Record<string, unknown>;
  mode: 'auto' | 'confirm' | 'propose';
}

export type ClientMessage =
  | { type: 'hello'; token: string; clientTools?: ClientToolDecl[] }
  | { type: 'run.start'; runId: string; input: string; agent?: string; sessionId?: string }
  | { type: 'consent.decision'; runId: string; callId: string; allow: boolean }
  | { type: 'tool.result'; runId: string; callId: string; result?: unknown; error?: string }
  | { type: 'run.cancel'; runId: string };

export type ServerMessage =
  | { type: 'ready'; agents: string[] }
  | { type: 'run.event'; runId: string; event: AgentEvent }
  | { type: 'tool.invoke'; runId: string; callId: string; name: string; args: unknown }
  | { type: 'error'; code: string; message: string; runId?: string };

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function str(v: unknown): v is string {
  return typeof v === 'string';
}

/** Lightweight, hand-rolled validation for the small client-message set. */
export function parseClientMessage(raw: unknown): Parsed<ClientMessage> {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'message must be an object' };
  const m = raw as Record<string, unknown>;
  switch (m.type) {
    case 'hello':
      if (!str(m.token)) return { ok: false, error: 'hello requires a string token' };
      return { ok: true, value: { type: 'hello', token: m.token, clientTools: m.clientTools as ClientToolDecl[] | undefined } };
    case 'run.start':
      if (!str(m.runId) || !str(m.input)) return { ok: false, error: 'run.start requires runId and input' };
      return {
        ok: true,
        value: {
          type: 'run.start',
          runId: m.runId,
          input: m.input,
          agent: str(m.agent) ? m.agent : undefined,
          sessionId: str(m.sessionId) ? m.sessionId : undefined,
        },
      };
    case 'consent.decision':
      if (!str(m.runId) || !str(m.callId) || typeof m.allow !== 'boolean')
        return { ok: false, error: 'consent.decision requires runId, callId, allow' };
      return { ok: true, value: { type: 'consent.decision', runId: m.runId, callId: m.callId, allow: m.allow } };
    case 'tool.result':
      if (!str(m.runId) || !str(m.callId)) return { ok: false, error: 'tool.result requires runId and callId' };
      return { ok: true, value: { type: 'tool.result', runId: m.runId, callId: m.callId, result: m.result, error: str(m.error) ? m.error : undefined } };
    case 'run.cancel':
      if (!str(m.runId)) return { ok: false, error: 'run.cancel requires runId' };
      return { ok: true, value: { type: 'run.cancel', runId: m.runId } };
    default:
      return { ok: false, error: `unknown message type: ${String(m.type)}` };
  }
}
