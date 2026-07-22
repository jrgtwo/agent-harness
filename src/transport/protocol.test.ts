import { describe, expect, it } from 'vitest';
import { parseClientMessage } from './protocol';

describe('parseClientMessage — consent.policy & run.cancelAll', () => {
  it('accepts a valid consent.policy', () => {
    expect(parseClientMessage({ type: 'consent.policy', mode: 'allow' })).toEqual({
      ok: true,
      value: { type: 'consent.policy', mode: 'allow' },
    });
  });

  it('rejects a consent.policy with an unknown mode', () => {
    expect(parseClientMessage({ type: 'consent.policy', mode: 'nope' }).ok).toBe(false);
  });

  it('accepts run.cancelAll', () => {
    expect(parseClientMessage({ type: 'run.cancelAll' })).toEqual({ ok: true, value: { type: 'run.cancelAll' } });
  });

  it('parses run.start cache fields (cacheKey / ttl), ignoring wrong types', () => {
    const ok = parseClientMessage({ type: 'run.start', runId: 'r', input: 'hi', cacheKey: 'k1', ttl: 1000 });
    expect(ok).toMatchObject({ ok: true, value: { cacheKey: 'k1', ttl: 1000 } });
    const bad = parseClientMessage({ type: 'run.start', runId: 'r', input: 'hi', cacheKey: 5, ttl: 'x' });
    expect(bad).toMatchObject({ ok: true, value: { cacheKey: undefined, ttl: undefined } });
  });
});
