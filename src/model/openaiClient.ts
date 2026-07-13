import type {
  Message,
  ModelCallResult,
  ModelClient,
  ModelProfile,
  ModelStreamHandlers,
  ModelToolSchema,
  ToolCall,
  Usage,
} from '../core/types';
import { parseTextToolCalls, TOOL_CALL_BLOCK } from './textToolCalls';

type FetchLike = typeof fetch;

interface WireMessage {
  role: string;
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

/**
 * The one v1 model backend: any OpenAI-compatible endpoint (local llama-server / Ollama / LM Studio,
 * or a remote frontier endpoint + key). Streams, assembles tool calls, reports finish_reason + usage.
 */
export class OpenAICompatibleClient implements ModelClient {
  private profile: ModelProfile;
  private fetchImpl: FetchLike;

  constructor(profile: ModelProfile, fetchImpl: FetchLike = fetch) {
    this.profile = profile;
    this.fetchImpl = fetchImpl;
  }

  async chat(
    messages: Message[],
    tools: ModelToolSchema[],
    handlers?: ModelStreamHandlers,
    signal?: AbortSignal,
  ): Promise<ModelCallResult> {
    // Call fetch unbound — invoking the native fetch as a method throws "Illegal invocation".
    const doFetch = this.fetchImpl;

    const body: Record<string, unknown> = {
      model: this.profile.model,
      messages: messages.map(toWire),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (tools.length) body.tools = tools.map(toOpenAITool);
    if (this.profile.temperature != null) body.temperature = this.profile.temperature;
    if (this.profile.maxTokens != null) body.max_tokens = this.profile.maxTokens;

    const res = await doFetch(`${trimSlash(this.profile.baseUrl)}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.profile.apiKey ? { authorization: `Bearer ${this.profile.apiKey}` } : {}),
        ...(this.profile.headers ?? {}),
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok || !res.body) {
      throw new Error(`model request failed (${res.status}): ${await safeText(res)}`);
    }
    return readStream(res.body, handlers);
  }
}

async function readStream(body: ReadableStream<Uint8Array>, handlers?: ModelStreamHandlers): Promise<ModelCallResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoning = '';
  let finishReason = 'stop';
  let usage: Usage | undefined;
  const parts = new Map<number, { id: string; name: string; arguments: string }>();

  const handleData = (data: string) => {
    if (data === '[DONE]') return;
    let json: any;
    try {
      json = JSON.parse(data);
    } catch {
      return; // ignore keep-alive / non-JSON lines
    }
    if (json.usage) {
      usage = {
        promptTokens: json.usage.prompt_tokens ?? 0,
        completionTokens: json.usage.completion_tokens ?? 0,
        totalTokens: json.usage.total_tokens ?? 0,
      };
    }
    const choice = json.choices?.[0];
    if (!choice) return;
    const delta = choice.delta ?? {};

    if (typeof delta.content === 'string' && delta.content.length) {
      content += delta.content;
      handlers?.onToken?.(delta.content);
    }
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length) {
      reasoning += delta.reasoning_content;
      handlers?.onThinking?.(delta.reasoning_content);
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx: number = tc.index ?? 0;
        const cur = parts.get(idx) ?? { id: '', name: '', arguments: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name = tc.function.name;
        if (typeof tc.function?.arguments === 'string') cur.arguments += tc.function.arguments;
        parts.set(idx, cur);
      }
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  };

  const drainLines = () => {
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('data:')) handleData(trimmed.slice('data:'.length).trim());
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    drainLines();
  }
  const rest = buffer.trim();
  if (rest.startsWith('data:')) handleData(rest.slice('data:'.length).trim());

  let toolCalls: ToolCall[] = [...parts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, c]) => ({ id: c.id || crypto.randomUUID(), name: c.name, arguments: c.arguments }));

  let finalContent = content;
  // Fallback for models that emit tool calls as <tool_call> TEXT rather than the structured
  // tool_calls field. Only runs when nothing structured came back, so well-behaved models are
  // untouched. Prefer content; if content is empty, rescue a call the model drafted in its
  // reasoning. Consent still gates each resulting call.
  if (toolCalls.length === 0) {
    const fromContent = parseTextToolCalls(content);
    if (fromContent.length) {
      toolCalls = fromContent.map((c) => ({ id: crypto.randomUUID(), name: c.name, arguments: c.arguments }));
      finalContent = content.replace(TOOL_CALL_BLOCK, '').trim();
    } else if (!content.trim()) {
      const fromReasoning = parseTextToolCalls(reasoning);
      if (fromReasoning.length) {
        toolCalls = fromReasoning.map((c) => ({ id: crypto.randomUUID(), name: c.name, arguments: c.arguments }));
      }
    }
  }

  return { content: finalContent, toolCalls, finishReason, usage };
}

function toWire(m: Message): WireMessage {
  if (m.role === 'assistant' && m.toolCalls?.length) {
    return {
      role: 'assistant',
      content: m.content || null,
      tool_calls: m.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.arguments },
      })),
    };
  }
  if (m.role === 'tool') {
    return { role: 'tool', content: m.content, tool_call_id: m.toolCallId };
  }
  return { role: m.role, content: m.content };
}

function toOpenAITool(t: ModelToolSchema) {
  return { type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } };
}

function trimSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return '<no body>';
  }
}
