import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../core/events';
import { HarnessClient, type HarnessClientHandlers } from './client';

// A drivable fake socket: capture listeners; let the test emit server messages.
class FakeSocket {
  readyState = 1;
  sent: string[] = [];
  private listeners: Record<string, ((ev: unknown) => void)[]> = {};
  static last: FakeSocket;
  constructor() {
    FakeSocket.last = this;
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {}
  addEventListener(type: string, listener: (ev: unknown) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }
  message(msg: unknown): void {
    for (const l of this.listeners.message ?? []) l({ data: JSON.stringify(msg) });
  }
}

const ev = (type: string, extra: object = {}): AgentEvent => ({ type, ...extra }) as AgentEvent;

async function connected(handlers: HarnessClientHandlers = {}) {
  const client = new HarnessClient('ws://x', 'tok', { handlers, WebSocketImpl: FakeSocket as never });
  const p = client.connect();
  FakeSocket.last.message({ type: 'ready', agents: ['a'] });
  await p;
  return { client, sock: FakeSocket.last };
}

describe('HarnessClient per-run event routing', () => {
  it('routes a run started with onEvent to its own handler, not the global', async () => {
    const globalEvents: string[] = [];
    const { client, sock } = await connected({ onEvent: (runId) => globalEvents.push(runId) });
    const runEvents: AgentEvent[] = [];
    const runId = client.startRun('hi', { onEvent: (e) => runEvents.push(e) });
    sock.message({ type: 'run.event', runId, event: ev('token', { runId, text: 'x' }) });
    expect(runEvents).toHaveLength(1);
    expect(globalEvents).toHaveLength(0);
  });

  it('falls back to the global handler for runs without a per-run onEvent', async () => {
    const globalEvents: string[] = [];
    const { client, sock } = await connected({ onEvent: (runId) => globalEvents.push(runId) });
    const runId = client.startRun('hi');
    sock.message({ type: 'run.event', runId, event: ev('token', { runId, text: 'x' }) });
    expect(globalEvents).toEqual([runId]);
  });

  it('setConsentPolicy and cancelAll send the right messages', async () => {
    const { client, sock } = await connected();
    client.setConsentPolicy('allow');
    client.cancelAll();
    const sent = sock.sent.map((s) => JSON.parse(s) as { type: string });
    expect(sent).toContainEqual({ type: 'consent.policy', mode: 'allow' });
    expect(sent).toContainEqual({ type: 'run.cancelAll' });
  });

  it('stops routing to a per-run listener after its terminal event', async () => {
    const { client, sock } = await connected();
    const runEvents: AgentEvent[] = [];
    const runId = client.startRun('hi', { onEvent: (e) => runEvents.push(e) });
    sock.message({ type: 'run.event', runId, event: ev('run.finished', { runId, result: 'ok' }) });
    sock.message({ type: 'run.event', runId, event: ev('token', { runId, text: 'late' }) });
    expect(runEvents.map((e) => e.type)).toEqual(['run.finished']);
  });
});
