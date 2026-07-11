// Core shared types for the harness. Kept deliberately small.

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON string of arguments as emitted by the model (fragments joined during streaming). */
  arguments: string;
}

export interface Message {
  role: Role;
  content: string;
  /** Present on assistant messages that requested tools. */
  toolCalls?: ToolCall[];
  /** Present on tool messages: which tool call this result answers. */
  toolCallId?: string;
}

/** A JSON Schema object. Loose at the type level; validated at runtime (ajv). */
export type JSONSchema = Record<string, unknown>;

/** Tool schema handed to the model. */
export interface ModelToolSchema {
  name: string;
  description: string;
  parameters: JSONSchema;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** OpenAI-style finish reasons; kept open since backends vary. */
export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter' | (string & {});

export interface ModelCallResult {
  content: string;
  toolCalls: ToolCall[];
  finishReason: FinishReason;
  usage?: Usage;
}

export interface ModelStreamHandlers {
  onToken?: (text: string) => void;
  onThinking?: (text: string) => void;
}

/** The single seam every model backend implements. */
export interface ModelClient {
  chat(
    messages: Message[],
    tools: ModelToolSchema[],
    handlers?: ModelStreamHandlers,
    signal?: AbortSignal,
  ): Promise<ModelCallResult>;
}

/** Connection config for the OpenAI-compatible client (a "profile"). */
export interface ModelProfile {
  baseUrl: string;
  model: string;
  apiKey?: string;
  headers?: Record<string, string>;
  contextWindow?: number;
  temperature?: number;
  maxTokens?: number;
}
