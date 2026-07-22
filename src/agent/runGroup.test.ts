import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../core/events';
import { runGroup, type RunGroupClient } from './runGroup';

const ev = (type: string, extra: object = {}): AgentEvent => ({ type, ...extra }) as AgentEvent;
const tick = () => new Promise((r) => setTimeout(r, 0));

// A fake client that records startRun/cancel and lets the test drive each run's events.
class FakeClient implements RunGroupClient {
  started: { runId: string; input: string; agent?: string; cacheKey?: string; onEvent: (e: AgentEvent) => void }[] = [];
  cancelled: string[] = [];
  private n = 0;
  startRun(
    input: string,
    opts: { agent?: string; onEvent?: (e: AgentEvent) => void; cacheKey?: string; ttl?: number },
  ): string {
    const runId = `r${this.n++}`;
    this.started.push({ runId, input, agent: opts.agent, cacheKey: opts.cacheKey, onEvent: opts.onEvent! });
    return runId;
  }
  cancel(runId: string): void {
    this.cancelled.push(runId);
  }
  emit(runId: string, event: AgentEvent): void {
    this.started.find((s) => s.runId === runId)!.onEvent(event);
  }
  finish(runId: string, result: unknown = 'ok'): void {
    this.emit(runId, ev('run.finished', { runId, result }));
  }
  error(runId: string, error = 'boom'): void {
    this.emit(runId, ev('run.error', { runId, error }));
  }
}

const items = (n: number) => Array.from({ length: n }, (_, i) => ({ input: `in${i}`, agent: 'scout' }));

describe('runGroup', () => {
  it('never exceeds the concurrency cap and starts the next as one settles', async () => {
    const c = new FakeClient();
    const p = runGroup(c, items(5), { concurrency: 2, onEvent: () => {} });
    expect(c.started).toHaveLength(2); // only the cap starts
    c.finish('r0');
    await tick();
    expect(c.started).toHaveLength(3); // one settled → one more starts (never > cap in flight)
    c.finish('r1');
    await tick();
    c.finish('r2');
    await tick();
    c.finish('r3');
    await tick();
    c.finish('r4');
    await p;
    expect(c.started).toHaveLength(5);
  });

  it('resolves only when all settle, with per-item status', async () => {
    const c = new FakeClient();
    const p = runGroup(c, items(3), { concurrency: 3, onEvent: () => {} });
    c.finish('r0', 'A');
    c.error('r1', 'bad');
    c.finish('r2', 'C');
    const results = await p;
    expect(results.map((r) => r.status)).toEqual(['done', 'error', 'done']);
    expect(results[0]!.result).toBe('A');
    expect(results[1]!.error).toBe('bad');
  });

  it('an erroring item does not stall the pool', async () => {
    const c = new FakeClient();
    const p = runGroup(c, items(3), { concurrency: 1, onEvent: () => {} });
    expect(c.started).toHaveLength(1);
    c.error('r0');
    await tick();
    expect(c.started).toHaveLength(2); // next starts despite the error
    c.finish('r1');
    await tick();
    c.finish('r2');
    await p;
  });

  it('routes events to onEvent with the item index and runId', async () => {
    const c = new FakeClient();
    const seen: [number, string, string][] = [];
    const p = runGroup(c, items(2), { concurrency: 2, onEvent: (i, runId, e) => seen.push([i, runId, e.type]) });
    c.emit('r0', ev('token', { runId: 'r0', text: 'x' }));
    c.finish('r0');
    c.finish('r1');
    await p;
    expect(seen).toContainEqual([0, 'r0', 'token']);
  });

  it('forwards each item\'s cacheKey to startRun', async () => {
    const c = new FakeClient();
    const items = [
      { input: 'a', agent: 'scout', cacheKey: 'k-a' },
      { input: 'b', agent: 'scout', cacheKey: 'k-b' },
    ];
    const p = runGroup(c, items, { concurrency: 2, onEvent: () => {} });
    expect(c.started.map((s) => s.cacheKey)).toEqual(['k-a', 'k-b']);
    c.finish('r0');
    c.finish('r1');
    await p;
  });

  it('abort stops starting queued items and cancels in-flight ones', async () => {
    const c = new FakeClient();
    const ac = new AbortController();
    const p = runGroup(c, items(5), { concurrency: 2, onEvent: () => {}, signal: ac.signal });
    expect(c.started).toHaveLength(2);
    ac.abort();
    const results = await p;
    expect(c.cancelled).toEqual(['r0', 'r1']); // in-flight cancelled
    expect(c.started).toHaveLength(2); // no queued items started
    expect(results.filter((r) => r?.status === 'aborted')).toHaveLength(2);
  });
});
