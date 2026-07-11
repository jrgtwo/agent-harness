import type { EventSink } from './events';
import type { Message, ModelClient, ToolCall } from './types';
import type { ToolDef, ToolRegistry } from './tools';

export interface ConsentRequest {
  runId: string;
  callId: string;
  tool: ToolDef;
  args: unknown;
}

/** How the harness asks a human (via the app) to approve a gated tool call. */
export type ConsentFn = (req: ConsentRequest) => Promise<boolean>;

export interface RunOptions {
  runId: string;
  input: string;
  systemPrompt: string;
  model: ModelClient;
  tools: ToolRegistry;
  emit: EventSink;
  requestConsent: ConsentFn;
  history?: Message[];
  signal?: AbortSignal;
  /** Outer bound on model round-trips. */
  maxIters?: number;
  /** Stop after an identical tool call repeats more than this many times. */
  repeatLimit?: number;
}

export type StopReason = 'answered' | 'max_iters' | 'loop_break' | 'aborted' | 'error';

export interface RunResult {
  messages: Message[];
  content: string;
  stoppedReason: StopReason;
}

/**
 * The agent loop: call the model, run any tools it asks for, feed results back, repeat until it
 * answers. The single chokepoint — every action emits an event here, so the trace is complete.
 */
export async function run(opts: RunOptions): Promise<RunResult> {
  const { runId, model, tools, emit, signal } = opts;
  const maxIters = opts.maxIters ?? 8;
  const repeatLimit = opts.repeatLimit ?? 3;

  const messages: Message[] = [
    { role: 'system', content: opts.systemPrompt },
    ...(opts.history ?? []),
    { role: 'user', content: opts.input },
  ];

  const callCounts = new Map<string, number>();
  emit({ type: 'run.started', runId });

  try {
    for (let iter = 0; iter < maxIters; iter++) {
      if (signal?.aborted) return { messages, content: '', stoppedReason: 'aborted' };

      emit({ type: 'model.call.started', runId, iter });
      const result = await model.chat(
        messages,
        tools.schemas(),
        {
          onToken: (text) => emit({ type: 'token', runId, text }),
          onThinking: (text) => emit({ type: 'thinking', runId, text }),
        },
        signal,
      );
      emit({
        type: 'model.call.finished',
        runId,
        iter,
        finishReason: result.finishReason,
        usage: result.usage,
      });

      messages.push({
        role: 'assistant',
        content: result.content,
        toolCalls: result.toolCalls.length ? result.toolCalls : undefined,
      });

      if (result.toolCalls.length === 0) {
        emit({ type: 'run.finished', runId, result: result.content });
        return { messages, content: result.content, stoppedReason: 'answered' };
      }

      for (const call of result.toolCalls) {
        const key = `${call.name}:${call.arguments}`;
        const n = (callCounts.get(key) ?? 0) + 1;
        callCounts.set(key, n);
        if (n > repeatLimit) {
          const msg = `Stopped: repeatedly called ${call.name} with identical arguments without making progress.`;
          emit({ type: 'run.finished', runId, result: msg });
          return { messages, content: msg, stoppedReason: 'loop_break' };
        }
        messages.push(await dispatch(call, opts));
      }
    }

    const msg = `Stopped: reached the step budget (${maxIters} iterations) without a final answer.`;
    emit({ type: 'run.finished', runId, result: msg });
    return { messages, content: msg, stoppedReason: 'max_iters' };
  } catch (err) {
    if (signal?.aborted || (err as Error)?.name === 'AbortError') {
      return { messages, content: '', stoppedReason: 'aborted' };
    }
    const error = (err as Error)?.message ?? String(err);
    emit({ type: 'run.error', runId, error });
    return { messages, content: '', stoppedReason: 'error' };
  }
}

/**
 * Run one tool call and produce the `tool` message fed back to the model. Every failure mode
 * (bad JSON, unknown tool, invalid args, denial, handler throw) becomes a *structured result*,
 * never an exception — so the model always gets something it can react to.
 */
async function dispatch(call: ToolCall, opts: RunOptions): Promise<Message> {
  const { runId, tools, emit, requestConsent } = opts;
  const toolMessage = (payload: unknown): Message => ({
    role: 'tool',
    toolCallId: call.id,
    content: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });

  let args: unknown;
  try {
    args = call.arguments && call.arguments.trim() ? JSON.parse(call.arguments) : {};
  } catch {
    const error = `arguments were not valid JSON: ${call.arguments}`;
    emit({ type: 'tool.finished', runId, callId: call.id, name: call.name, ok: false, error, ms: 0 });
    return toolMessage({ error });
  }

  emit({ type: 'tool.requested', runId, callId: call.id, name: call.name, args });

  const tool = tools.get(call.name);
  if (!tool) {
    const error = `unknown tool "${call.name}". Available tools: ${tools.names().join(', ') || '(none)'}.`;
    emit({ type: 'tool.finished', runId, callId: call.id, name: call.name, ok: false, error, ms: 0 });
    return toolMessage({ error });
  }

  const valid = tools.validate(call.name, args);
  if (!valid.ok) {
    const error = `invalid arguments for "${call.name}": ${valid.errors}`;
    emit({ type: 'tool.finished', runId, callId: call.id, name: call.name, ok: false, error, ms: 0 });
    return toolMessage({ error });
  }

  // v1 consent policy: gate everything except a tool explicitly marked `auto`.
  if (tool.mode !== 'auto') {
    emit({ type: 'consent.requested', runId, callId: call.id, name: call.name, args });
    const allow = await requestConsent({ runId, callId: call.id, tool, args });
    emit({ type: 'consent.decided', runId, callId: call.id, allow });
    if (!allow) {
      return toolMessage({ denied: true, message: `user denied "${call.name}"` });
    }
  }

  emit({ type: 'tool.started', runId, callId: call.id, name: call.name });
  const started = Date.now();
  try {
    const out = await tool.handler(args);
    const ms = Date.now() - started;
    emit({ type: 'tool.finished', runId, callId: call.id, name: call.name, ok: true, result: out, ms });
    return toolMessage(out ?? { ok: true });
  } catch (err) {
    const ms = Date.now() - started;
    const error = (err as Error)?.message ?? String(err);
    emit({ type: 'tool.finished', runId, callId: call.id, name: call.name, ok: false, error, ms });
    return toolMessage({ error });
  }
}
