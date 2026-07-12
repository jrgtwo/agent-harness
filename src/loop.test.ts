import { describe, it, expect, vi } from 'vitest';
import { run, type ConsentFn } from './loop';
import { ToolRegistry, type ToolDef } from './tools';
import type { AgentEvent } from './events';
import type { Message, ModelCallResult, ModelClient, ModelStreamHandlers, ModelToolSchema } from './types';

/** A model whose responses are scripted, so we can exercise the loop with no real backend. */
class ScriptedModel implements ModelClient {
  calls: Message[][] = [];
  constructor(private queue: ModelCallResult[]) {}
  async chat(
    messages: Message[],
    _tools: ModelToolSchema[],
    handlers?: ModelStreamHandlers,
  ): Promise<ModelCallResult> {
    this.calls.push(structuredClone(messages));
    const next = this.queue.shift();
    if (!next) throw new Error('ScriptedModel ran out of scripted responses');
    if (next.content) handlers?.onToken?.(next.content);
    return next;
  }
}

const answer = (content: string): ModelCallResult => ({ content, toolCalls: [], finishReason: 'stop' });
const callTool = (id: string, name: string, args: object): ModelCallResult => ({
  content: '',
  toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
  finishReason: 'tool_calls',
});

function echoTool(
  handler: ToolDef['handler'] = (a: { msg: string }) => ({ echoed: a.msg }),
  mode: ToolDef['mode'] = 'confirm',
): ToolDef {
  return {
    name: 'echo',
    description: 'echo',
    mode,
    params: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'], additionalProperties: false },
    handler,
  };
}

const allow: ConsentFn = async () => true;
const deny: ConsentFn = async () => false;

function collect() {
  const events: AgentEvent[] = [];
  return { events, emit: (e: AgentEvent) => events.push(e) };
}

describe('agent loop', () => {
  it('answers directly when the model requests no tools', async () => {
    const model = new ScriptedModel([answer('hello there')]);
    const { events, emit } = collect();
    const res = await run({
      runId: 'r1',
      input: 'hi',
      systemPrompt: 'sys',
      model,
      tools: new ToolRegistry(),
      emit,
      requestConsent: allow,
    });
    expect(res.stoppedReason).toBe('answered');
    expect(res.content).toBe('hello there');
    expect(events.map((e) => e.type)).toEqual([
      'run.started',
      'model.call.started',
      'token',
      'model.call.finished',
      'run.finished',
    ]);
  });

  it('runs a gated tool after consent, feeds the result back, then answers', async () => {
    const handler = vi.fn((a: { msg: string }) => ({ echoed: a.msg }));
    const tools = new ToolRegistry();
    tools.register([echoTool(handler)]);
    const model = new ScriptedModel([callTool('c1', 'echo', { msg: 'hi' }), answer('done')]);
    const { events, emit } = collect();

    const res = await run({ runId: 'r', input: 'go', systemPrompt: 's', model, tools, emit, requestConsent: allow });

    expect(res.stoppedReason).toBe('answered');
    expect(res.content).toBe('done');
    expect(handler).toHaveBeenCalledWith({ msg: 'hi' });

    const types = events.map((e) => e.type);
    expect(types).toContain('tool.requested');
    expect(types).toContain('consent.requested');
    expect(types).toContain('consent.decided');
    expect(types).toContain('tool.started');
    expect(types).toContain('tool.finished');

    // the model's second call must include the tool result
    const secondCall = model.calls[1]!;
    const toolMsg = secondCall.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toContain('echoed');
  });

  it('does not run the handler when consent is denied, and feeds a denial back', async () => {
    const handler = vi.fn();
    const tools = new ToolRegistry();
    tools.register([echoTool(handler)]);
    const model = new ScriptedModel([callTool('c1', 'echo', { msg: 'hi' }), answer('ok')]);
    const { events, emit } = collect();

    await run({ runId: 'r', input: 'go', systemPrompt: 's', model, tools, emit, requestConsent: deny });

    expect(handler).not.toHaveBeenCalled();
    expect(events.find((e) => e.type === 'consent.decided')).toMatchObject({ allow: false });
    const toolMsg = model.calls[1]!.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toContain('denied');
  });

  it('skips consent for an auto-mode tool', async () => {
    const handler = vi.fn(() => ({ ok: true }));
    const tools = new ToolRegistry();
    tools.register([echoTool(handler, 'auto')]);
    const model = new ScriptedModel([callTool('c1', 'echo', { msg: 'hi' }), answer('done')]);
    const { events, emit } = collect();

    await run({ runId: 'r', input: 'go', systemPrompt: 's', model, tools, emit, requestConsent: deny });

    expect(handler).toHaveBeenCalled(); // ran despite deny, because mode is auto
    expect(events.some((e) => e.type === 'consent.requested')).toBe(false);
  });

  it('returns a structured error listing tools when the model calls an unknown tool', async () => {
    const tools = new ToolRegistry();
    tools.register([echoTool()]);
    const model = new ScriptedModel([callTool('c1', 'nope', {}), answer('recovered')]);
    const { emit } = collect();

    await run({ runId: 'r', input: 'go', systemPrompt: 's', model, tools, emit, requestConsent: allow });

    const toolMsg = model.calls[1]!.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toMatch(/unknown tool/);
    expect(toolMsg?.content).toMatch(/echo/); // lists what's available
  });

  it('feeds a validation error back when args do not match the schema', async () => {
    const handler = vi.fn();
    const tools = new ToolRegistry();
    tools.register([echoTool(handler, 'auto')]);
    const model = new ScriptedModel([callTool('c1', 'echo', { wrong: 1 }), answer('ok')]);
    const { emit } = collect();

    await run({ runId: 'r', input: 'go', systemPrompt: 's', model, tools, emit, requestConsent: allow });

    expect(handler).not.toHaveBeenCalled();
    const toolMsg = model.calls[1]!.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toMatch(/invalid arguments/);
  });

  it('breaks out of an identical-call loop', async () => {
    const tools = new ToolRegistry();
    tools.register([echoTool(() => ({ echoed: 'x' }), 'auto')]);
    // model keeps asking for the same call forever
    const model = new ScriptedModel(Array.from({ length: 20 }, () => callTool('c', 'echo', { msg: 'same' })));
    const { emit } = collect();

    const res = await run({
      runId: 'r',
      input: 'go',
      systemPrompt: 's',
      model,
      tools,
      emit,
      requestConsent: allow,
      repeatLimit: 2,
    });
    expect(res.stoppedReason).toBe('loop_break');
  });

  it('stops at the step budget when the model never answers', async () => {
    let i = 0;
    const tools = new ToolRegistry();
    tools.register([echoTool(() => ({ echoed: 'x' }), 'auto')]);
    // unique args each turn so the loop-breaker does not trigger first
    const model: ModelClient = {
      async chat() {
        return callTool(`c${i}`, 'echo', { msg: `n${i++}` });
      },
    };
    const { emit } = collect();
    const res = await run({
      runId: 'r',
      input: 'go',
      systemPrompt: 's',
      model,
      tools,
      emit,
      requestConsent: allow,
      maxIters: 3,
    });
    expect(res.stoppedReason).toBe('max_iters');
  });

  it('caps oversized tool results before feeding them back', async () => {
    const tools = new ToolRegistry();
    tools.register([
      { name: 'big', description: 'd', mode: 'auto', params: { type: 'object' }, handler: () => 'Z'.repeat(9000) },
    ]);
    const seen: Message[][] = [];
    const model: ModelClient = {
      async chat(messages) {
        seen.push(structuredClone(messages));
        return seen.length === 1 ? callTool('c', 'big', {}) : answer('ok');
      },
    };
    const { emit } = collect();
    await run({
      runId: 'r',
      input: 'go',
      systemPrompt: 's',
      model,
      tools,
      emit,
      requestConsent: allow,
      context: { maxToolResultChars: 100 },
    });
    const toolMsg = seen[1]!.find((m) => m.role === 'tool');
    expect(toolMsg!.content.length).toBeLessThan(200);
    expect(toolMsg!.content).toMatch(/truncated/);
  });

  it('injects live-state into the system prompt each turn', async () => {
    let tick = 0;
    const seen: Message[][] = [];
    const model: ModelClient = {
      async chat(messages) {
        seen.push(structuredClone(messages));
        return answer('done');
      },
    };
    const { emit } = collect();
    await run({
      runId: 'r',
      input: 'go',
      systemPrompt: 'base',
      model,
      tools: new ToolRegistry(),
      emit,
      requestConsent: allow,
      context: { provider: () => `tick=${tick++}` },
    });
    expect(seen[0]![0]!.content).toBe('base\n\ntick=0');
  });

  it('compacts oversized history before the first model call', async () => {
    const bigHistory: Message[] = Array.from({ length: 12 }, (_, i) => ({
      role: 'user' as const,
      content: `old ${i} ${'x'.repeat(300)}`,
    }));
    const summarizer: ModelClient = { async chat() { return answer('SUMMARY'); } };
    const seen: Message[][] = [];
    const model: ModelClient = {
      async chat(messages) {
        seen.push(structuredClone(messages));
        return answer('final');
      },
    };
    const { events, emit } = collect();
    const res = await run({
      runId: 'r',
      input: 'now',
      systemPrompt: 's',
      model,
      tools: new ToolRegistry(),
      emit,
      requestConsent: allow,
      history: bigHistory,
      context: { window: 50, keepRecent: 3, summarizeModel: summarizer },
    });

    expect(res.stoppedReason).toBe('answered');
    expect(events.some((e) => e.type === 'context.compacted')).toBe(true);
    const firstCall = seen[0]!;
    expect(firstCall.some((m) => m.role === 'system' && m.content.includes('Summary of earlier conversation'))).toBe(true);
    expect(firstCall.some((m) => m.content.includes('old 11'))).toBe(true); // recent tail kept
    expect(firstCall.some((m) => m.content.includes('old 0'))).toBe(false); // oldest summarized away
  });
});
