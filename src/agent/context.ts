import type { Message, ModelClient, ModelToolSchema } from '../core/types';

// Context handling: keep the prompt under the model's window, cap oversized tool output, and
// fold live app-state into the system prompt each turn. All optional — off unless configured.

/** Cheap pre-call token estimate (~chars/4). Good enough to drive budgeting decisions. */
export function estimateTokens(messages: Message[], tools: ModelToolSchema[] = []): number {
  const chars = JSON.stringify(messages).length + (tools.length ? JSON.stringify(tools).length : 0);
  return Math.ceil(chars / 4);
}

/** Truncate oversized text (e.g. a huge tool result) before it enters history. */
export function capText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…[truncated ${text.length - maxChars} chars]`;
}

/** Fold a fresh live-state snapshot into the system prompt (transient — never persisted). */
export function injectLiveState(systemPrompt: string, liveState?: string): string {
  const s = liveState?.trim();
  return s ? `${systemPrompt}\n\n${s}` : systemPrompt;
}

export interface CompactParams {
  /** Total token budget for the whole prompt. */
  budget: number;
  /** Always keep this many most-recent messages verbatim. */
  keepRecent: number;
  /** Tokens for the always-present parts (system + current input + tool schemas). */
  fixedTokens: number;
  /** Produce a summary of the messages that fall out of the recent window. */
  summarize: (old: Message[]) => Promise<string>;
}

export interface CompactResult {
  history: Message[];
  /** How many old messages were folded into a summary (0 = no compaction happened). */
  summarized: number;
}

/**
 * Keep history under budget: recent messages verbatim, everything older folded into a running
 * summary. Returns the (possibly compacted) history to place before the current input.
 */
export async function compactHistory(history: Message[], p: CompactParams): Promise<CompactResult> {
  const fits = p.fixedTokens + estimateTokens(history) <= p.budget;
  if (fits || history.length <= p.keepRecent) return { history, summarized: 0 };

  const recent = history.slice(-p.keepRecent);
  const old = history.slice(0, history.length - p.keepRecent);
  const summary = await p.summarize(old);
  const summaryMsg: Message = { role: 'system', content: `Summary of earlier conversation:\n${summary}` };
  return { history: [summaryMsg, ...recent], summarized: old.length };
}

/** Summarize a slice of conversation with the model. Preserves names/facts/decisions. */
export async function summarizeMessages(model: ModelClient, messages: Message[]): Promise<string> {
  const transcript = messages
    .map((m) => {
      const calls = m.toolCalls?.length ? ` [called: ${m.toolCalls.map((t) => t.name).join(', ')}]` : '';
      return `${m.role}: ${m.content}${calls}`;
    })
    .join('\n');
  const res = await model.chat(
    [
      {
        role: 'system',
        content:
          'Summarize the following conversation concisely. Preserve names, facts, decisions, and any unresolved questions. Output only the summary.',
      },
      { role: 'user', content: transcript },
    ],
    [],
  );
  return res.content.trim();
}
