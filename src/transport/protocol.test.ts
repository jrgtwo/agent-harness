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
});
