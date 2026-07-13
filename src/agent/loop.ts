import Ajv, { type ValidateFunction } from 'ajv';
import { capText, compactHistory, estimateTokens, injectLiveState, summarizeMessages } from './context';
import type { EventSink } from '../core/events';
import type { JSONSchema, Message, ModelClient, ModelToolSchema, ToolCall } from '../core/types';
import type { ClientToolDecl } from '../transport/protocol';
import type { ToolDef, ToolRegistry } from './tools';

const ajv = new Ajv({ allErrors: true, strict: false });

export interface ConsentRequest {
  runId: string;
  callId: string;
  tool: ToolDef;
  args: unknown;
}

/** How the harness asks a human (via the app) to approve a gated tool call. */
export type ConsentFn = (req: ConsentRequest) => Promise<boolean>;

/** A model tool-call routed out to an app-side (client) tool handler over the transport. */
export interface ClientToolInvocation {
  runId: string;
  callId: string;
  name: string;
  args: unknown;
}

/** Bridge the loop uses to run a client-declared tool: send the invoke, await the app's result. */
export type InvokeClientTool = (req: ClientToolInvocation) => Promise<{ result?: unknown; error?: string }>;

/** Optional context management. All off unless set. */
export interface ContextConfig {
  /** Token budget for the whole prompt; enables history compaction when set. */
  window?: number;
  /** Messages kept verbatim before summarizing older ones (default 8). */
  keepRecent?: number;
  /** Cap on a single tool result's size in chars (default 4000). */
  maxToolResultChars?: number;
  /** Live app-state snapshot folded into the system prompt each turn (never persisted). */
  provider?: () => string;
  /** Model used for summaries (defaults to the run's model). */
  summarizeModel?: ModelClient;
}

export interface RunOptions {
  runId: string;
  input: string;
  systemPrompt: string;
  model: ModelClient;
  tools: ToolRegistry;
  emit: EventSink;
  requestConsent: ConsentFn;
  /** Tools whose handler lives in the app UI (declared by the client on connect), invoked via RPC. */
  clientTools?: ClientToolDecl[];
  /** How the loop reaches an app-side tool handler. Required for `clientTools` to actually run. */
  invokeClientTool?: InvokeClientTool;
  history?: Message[];
  signal?: AbortSignal;
  /** Outer bound on model round-trips. */
  maxIters?: number;
  /** Stop after an identical tool call repeats more than this many times. */
  repeatLimit?: number;
  context?: ContextConfig;
}

export type StopReason = 'answered' | 'max_iters' | 'loop_break' | 'aborted' | 'error';

export interface RunResult {
  messages: Message[];
  /** Just this turn's new messages (user input + everything produced) — what to persist. */
  newMessages: Message[];
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
  const ctx = opts.context ?? {};
  const keepRecent = ctx.keepRecent ?? 8;
  const maxToolResultChars = ctx.maxToolResultChars ?? 4000;

  let history = opts.history ?? [];
  const userMsg: Message = { role: 'user', content: opts.input };
  const callCounts = new Map<string, number>();

  // Client-declared tools: compile a validator per decl and build the schemas offered to the model
  // alongside the server-side registry's. Dispatch routes a call to the app when it matches one.
  const clientTools = new Map<string, { decl: ClientToolDecl; validate: ValidateFunction }>();
  for (const decl of opts.clientTools ?? []) {
    clientTools.set(decl.name, { decl, validate: ajv.compile(decl.params as JSONSchema) });
  }
  const clientToolSchemas: ModelToolSchema[] = (opts.clientTools ?? []).map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.params as JSONSchema,
  }));
  const modelSchemas = (): ModelToolSchema[] => [...tools.schemas(), ...clientToolSchemas];

  let messages: Message[] = [];
  let newStart = 0;
  const done = (content: string, stoppedReason: StopReason): RunResult => ({
    messages,
    newMessages: messages.slice(newStart),
    content,
    stoppedReason,
  });

  emit({ type: 'run.started', runId });

  try {
    // Keep history under budget: recent verbatim, older folded into a summary.
    if (ctx.window) {
      const sys: Message = { role: 'system', content: injectLiveState(opts.systemPrompt, ctx.provider?.()) };
      const fixedTokens = estimateTokens([sys, userMsg], modelSchemas());
      const compacted = await compactHistory(history, {
        budget: ctx.window,
        keepRecent,
        fixedTokens,
        summarize: (old) => summarizeMessages(ctx.summarizeModel ?? model, old),
      });
      if (compacted.summarized > 0) emit({ type: 'context.compacted', runId, summarized: compacted.summarized });
      history = compacted.history;
    }

    messages = [{ role: 'system', content: opts.systemPrompt }, ...history, userMsg];
    newStart = 1 + history.length; // index of userMsg; from here on is this turn's new messages

    for (let iter = 0; iter < maxIters; iter++) {
      if (signal?.aborted) return done('', 'aborted');

      // Refresh transient live-state into the system slot each turn.
      messages[0] = { role: 'system', content: injectLiveState(opts.systemPrompt, ctx.provider?.()) };

      emit({ type: 'model.call.started', runId, iter });
      const result = await model.chat(
        messages,
        modelSchemas(),
        {
          onToken: (text) => emit({ type: 'token', runId, text }),
          onThinking: (text) => emit({ type: 'thinking', runId, text }),
        },
        signal,
      );
      emit({ type: 'model.call.finished', runId, iter, finishReason: result.finishReason, usage: result.usage });

      messages.push({
        role: 'assistant',
        content: result.content,
        toolCalls: result.toolCalls.length ? result.toolCalls : undefined,
      });

      if (result.toolCalls.length === 0) {
        emit({ type: 'run.finished', runId, result: result.content });
        return done(result.content, 'answered');
      }

      for (const call of result.toolCalls) {
        const key = `${call.name}:${call.arguments}`;
        const n = (callCounts.get(key) ?? 0) + 1;
        callCounts.set(key, n);
        if (n > repeatLimit) {
          const msg = `Stopped: repeatedly called ${call.name} with identical arguments without making progress.`;
          emit({ type: 'run.finished', runId, result: msg });
          return done(msg, 'loop_break');
        }
        messages.push(await dispatch(call, opts, maxToolResultChars, clientTools));
      }
    }

    const msg = `Stopped: reached the step budget (${maxIters} iterations) without a final answer.`;
    emit({ type: 'run.finished', runId, result: msg });
    return done(msg, 'max_iters');
  } catch (err) {
    if (signal?.aborted || (err as Error)?.name === 'AbortError') {
      return done('', 'aborted');
    }
    const error = (err as Error)?.message ?? String(err);
    emit({ type: 'run.error', runId, error });
    return done('', 'error');
  }
}

/**
 * Run one tool call and produce the `tool` message fed back to the model. Every failure mode
 * (bad JSON, unknown tool, invalid args, denial, handler throw) becomes a *structured result*,
 * never an exception — so the model always gets something it can react to.
 */
async function dispatch(
  call: ToolCall,
  opts: RunOptions,
  maxToolResultChars: number,
  clientTools: Map<string, { decl: ClientToolDecl; validate: ValidateFunction }>,
): Promise<Message> {
  const { runId, tools, emit, requestConsent } = opts;
  const toolMessage = (payload: unknown): Message => ({
    role: 'tool',
    toolCallId: call.id,
    content: capText(typeof payload === 'string' ? payload : JSON.stringify(payload), maxToolResultChars),
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
    // A name absent from the server registry may be a client-declared (app-side) tool.
    const client = clientTools.get(call.name);
    if (client) return dispatchClientTool(call, opts, client, args, toolMessage);
    const names = [...tools.names(), ...clientTools.keys()];
    const error = `unknown tool "${call.name}". Available tools: ${names.join(', ') || '(none)'}.`;
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

/**
 * Run a client-declared tool: validate args, apply the same consent gate as server tools, then
 * hand the call to the app over the transport and feed its response back. Mirrors the server-tool
 * path (validation → consent → run → structured result) so the model can't tell the difference.
 */
async function dispatchClientTool(
  call: ToolCall,
  opts: RunOptions,
  client: { decl: ClientToolDecl; validate: ValidateFunction },
  args: unknown,
  toolMessage: (payload: unknown) => Message,
): Promise<Message> {
  const { runId, emit, requestConsent, invokeClientTool } = opts;
  const { decl, validate } = client;

  if (!validate(args)) {
    const detail = (validate.errors ?? []).map((e) => `${e.instancePath || '(root)'} ${e.message ?? 'invalid'}`).join('; ');
    const error = `invalid arguments for "${call.name}": ${detail || 'failed schema validation'}`;
    emit({ type: 'tool.finished', runId, callId: call.id, name: call.name, ok: false, error, ms: 0 });
    return toolMessage({ error });
  }

  // Same v1 consent policy as server tools: gate everything except a tool explicitly marked `auto`.
  if (decl.mode !== 'auto') {
    const toolShape: ToolDef = { name: decl.name, description: decl.description, params: decl.params as JSONSchema, mode: decl.mode, handler: () => undefined };
    emit({ type: 'consent.requested', runId, callId: call.id, name: call.name, args });
    const allow = await requestConsent({ runId, callId: call.id, tool: toolShape, args });
    emit({ type: 'consent.decided', runId, callId: call.id, allow });
    if (!allow) return toolMessage({ denied: true, message: `user denied "${call.name}"` });
  }

  if (!invokeClientTool) {
    const error = `client tool "${call.name}" was declared but no client-tool bridge is available`;
    emit({ type: 'tool.finished', runId, callId: call.id, name: call.name, ok: false, error, ms: 0 });
    return toolMessage({ error });
  }

  emit({ type: 'tool.started', runId, callId: call.id, name: call.name });
  const started = Date.now();
  try {
    const outcome = await invokeClientTool({ runId, callId: call.id, name: call.name, args });
    const ms = Date.now() - started;
    if (outcome.error) {
      emit({ type: 'tool.finished', runId, callId: call.id, name: call.name, ok: false, error: outcome.error, ms });
      return toolMessage({ error: outcome.error });
    }
    emit({ type: 'tool.finished', runId, callId: call.id, name: call.name, ok: true, result: outcome.result, ms });
    return toolMessage(outcome.result ?? { ok: true });
  } catch (err) {
    const ms = Date.now() - started;
    const error = (err as Error)?.message ?? String(err);
    emit({ type: 'tool.finished', runId, callId: call.id, name: call.name, ok: false, error, ms });
    return toolMessage({ error });
  }
}
