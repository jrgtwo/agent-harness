import { describe, it, expect, vi } from 'vitest';
import { OpenAICompatibleClient } from './openaiClient';
import type { ModelProfile } from '../core/types';
import { TOOL_CALL_LEAK_NOTICE } from './textToolCalls';

const profile: ModelProfile = { baseUrl: 'http://localhost:5174/v1', model: 'local' };

function sseResponse(chunks: string[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('OpenAICompatibleClient', () => {
  it('accumulates streamed text content and reports finish_reason + usage', async () => {
    const fetchImpl = vi.fn(async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n',
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n',
        'data: {"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}\n',
        'data: [DONE]\n',
      ]),
    );
    const client = new OpenAICompatibleClient(profile, fetchImpl as unknown as typeof fetch);

    const tokens: string[] = [];
    const result = await client.chat([{ role: 'user', content: 'hi' }], [], {
      onToken: (t) => tokens.push(t),
    });

    expect(result.content).toBe('Hello');
    expect(result.finishReason).toBe('stop');
    expect(result.usage?.totalTokens).toBe(12);
    expect(tokens).toEqual(['Hel', 'lo']);
    expect(result.toolCalls).toHaveLength(0);
  });

  it('assembles a tool call whose arguments arrive across multiple deltas', async () => {
    const fetchImpl = vi.fn(async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"web_search","arguments":"{\\"query\\":\\""}}]}}]}\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"weather\\"}"}}]}}]}\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n',
        'data: [DONE]\n',
      ]),
    );
    const client = new OpenAICompatibleClient(profile, fetchImpl as unknown as typeof fetch);

    const result = await client.chat(
      [{ role: 'user', content: 'weather?' }],
      [{ name: 'web_search', description: 'search', parameters: { type: 'object' } }],
    );

    expect(result.finishReason).toBe('tool_calls');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({
      id: 'call_1',
      name: 'web_search',
      arguments: '{"query":"weather"}',
    });
  });

  it('sends tools + model in the request body and streams', async () => {
    const fetchImpl = vi.fn(async () =>
      sseResponse(['data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n', 'data: [DONE]\n']),
    );
    const client = new OpenAICompatibleClient(profile, fetchImpl as unknown as typeof fetch);
    await client.chat(
      [{ role: 'user', content: 'x' }],
      [{ name: 't', description: 'd', parameters: { type: 'object' } }],
    );

    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe('http://localhost:5174/v1/chat/completions');
    const body = JSON.parse(call[1].body as string);
    expect(body.model).toBe('local');
    expect(body.stream).toBe(true);
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].function.name).toBe('t');
  });

  it('throws a descriptive error on a non-ok response', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }));
    const client = new OpenAICompatibleClient(profile, fetchImpl as unknown as typeof fetch);
    await expect(client.chat([{ role: 'user', content: 'x' }], [])).rejects.toThrow(/500/);
  });

  it('falls back to a <tool_call> text block in content when there are no structured tool_calls', async () => {
    const fetchImpl = vi.fn(async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"<tool_call><function=fetch_url><parameter=url>https://x.com</parameter></function></tool_call>"}}]}\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n',
        'data: [DONE]\n',
      ]),
    );
    const client = new OpenAICompatibleClient(profile, fetchImpl as unknown as typeof fetch);
    const result = await client.chat([{ role: 'user', content: 'x' }], []);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({ name: 'fetch_url', arguments: '{"url":"https://x.com"}' });
    expect(result.content).toBe('');
  });

  it('rescues a SINGLE tool call drafted in reasoning when content is empty', async () => {
    const fetchImpl = vi.fn(async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"reasoning_content":"hmm <tool_call><function=web_search><parameter=query>rodgers</parameter></function></tool_call>"}}]}\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n',
        'data: [DONE]\n',
      ]),
    );
    const client = new OpenAICompatibleClient(profile, fetchImpl as unknown as typeof fetch);
    const result = await client.chat([{ role: 'user', content: 'x' }], []);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({ name: 'web_search', arguments: '{"query":"rodgers"}' });
  });

  it('does NOT fire multiple drafted tool calls from reasoning; surfaces a diagnostic instead', async () => {
    const fetchImpl = vi.fn(async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"reasoning_content":"maybe <tool_call><function=fetch_url><parameter=url>https://a.com</parameter></function></tool_call> or <tool_call><function=fetch_url><parameter=url>https://b.com</parameter></function></tool_call>"}}]}\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n',
        'data: [DONE]\n',
      ]),
    );
    const client = new OpenAICompatibleClient(profile, fetchImpl as unknown as typeof fetch);
    const result = await client.chat([{ role: 'user', content: 'x' }], []);
    expect(result.toolCalls).toHaveLength(0);
    expect(result.content).toBe(TOOL_CALL_LEAK_NOTICE);
  });
});
