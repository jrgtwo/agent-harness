import { describe, it, expect, vi } from 'vitest';
import { estimateTokens, capText, injectLiveState, compactHistory, summarizeMessages } from './context';
import type { Message, ModelCallResult, ModelClient } from '../core/types';

describe('context helpers', () => {
  it('estimates tokens from serialized size', () => {
    const t = estimateTokens([{ role: 'user', content: 'x'.repeat(400) }]);
    expect(t).toBeGreaterThan(90); // ~400 chars / 4, plus envelope
  });

  it('caps oversized text with a marker and leaves small text alone', () => {
    expect(capText('short', 100)).toBe('short');
    const capped = capText('y'.repeat(50), 10);
    expect(capped.startsWith('y'.repeat(10))).toBe(true);
    expect(capped).toMatch(/truncated 40 chars/);
  });

  it('injects live state into the system prompt transiently', () => {
    expect(injectLiveState('base')).toBe('base');
    expect(injectLiveState('base', '  key: A  ')).toBe('base\n\nkey: A');
  });
});

describe('compactHistory', () => {
  const summarize = vi.fn(async (_old: Message[]) => 'SUMMARY');

  it('leaves history alone when it fits the budget', async () => {
    summarize.mockClear();
    const history: Message[] = [{ role: 'user', content: 'hi' }];
    const res = await compactHistory(history, { budget: 100000, keepRecent: 4, fixedTokens: 0, summarize });
    expect(res.summarized).toBe(0);
    expect(res.history).toBe(history);
    expect(summarize).not.toHaveBeenCalled();
  });

  it('summarizes older messages and keeps the recent tail when over budget', async () => {
    summarize.mockClear();
    const history: Message[] = Array.from({ length: 10 }, (_, i) => ({
      role: 'user' as const,
      content: `message ${i} ${'x'.repeat(200)}`,
    }));
    const res = await compactHistory(history, { budget: 50, keepRecent: 3, fixedTokens: 0, summarize });

    expect(summarize).toHaveBeenCalledOnce();
    expect(res.summarized).toBe(7); // 10 - 3 recent
    expect(res.history[0]).toEqual({ role: 'system', content: 'Summary of earlier conversation:\nSUMMARY' });
    expect(res.history).toHaveLength(4); // summary + 3 recent
    expect(res.history.at(-1)?.content).toContain('message 9');
  });

  it('does not summarize when there are fewer messages than keepRecent', async () => {
    summarize.mockClear();
    const history: Message[] = [{ role: 'user', content: 'x'.repeat(10000) }];
    const res = await compactHistory(history, { budget: 1, keepRecent: 4, fixedTokens: 0, summarize });
    expect(res.summarized).toBe(0);
    expect(summarize).not.toHaveBeenCalled();
  });
});

describe('summarizeMessages', () => {
  it('renders a transcript and returns the model summary', async () => {
    let seenPrompt = '';
    const model: ModelClient = {
      async chat(messages): Promise<ModelCallResult> {
        seenPrompt = messages[1]?.content ?? '';
        return { content: '  the summary  ', toolCalls: [], finishReason: 'stop' };
      },
    };
    const summary = await summarizeMessages(model, [
      { role: 'user', content: 'my name is Jon' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'lookup', arguments: '{}' }] },
    ]);
    expect(summary).toBe('the summary');
    expect(seenPrompt).toContain('user: my name is Jon');
    expect(seenPrompt).toContain('[called: lookup]');
  });
});
