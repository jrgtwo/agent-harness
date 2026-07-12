import type { Usage } from './types';

/**
 * The typed event stream the loop emits. The loop is the single chokepoint every action
 * flows through, so this trace is complete by construction. The harness always emits;
 * whether an app displays it is the app's choice.
 */
export type AgentEvent =
  | { type: 'run.started'; runId: string }
  | { type: 'model.call.started'; runId: string; iter: number }
  | { type: 'token'; runId: string; text: string }
  | { type: 'thinking'; runId: string; text: string }
  | { type: 'model.call.finished'; runId: string; iter: number; finishReason: string; usage?: Usage }
  | { type: 'tool.requested'; runId: string; callId: string; name: string; args: unknown }
  | { type: 'consent.requested'; runId: string; callId: string; name: string; args: unknown }
  | { type: 'consent.decided'; runId: string; callId: string; allow: boolean }
  | { type: 'tool.started'; runId: string; callId: string; name: string }
  | {
      type: 'tool.finished';
      runId: string;
      callId: string;
      name: string;
      ok: boolean;
      result?: unknown;
      error?: string;
      ms: number;
    }
  | { type: 'context.compacted'; runId: string; summarized: number }
  | { type: 'run.finished'; runId: string; result: unknown }
  | { type: 'run.error'; runId: string; error: string };

export type EventSink = (event: AgentEvent) => void;
