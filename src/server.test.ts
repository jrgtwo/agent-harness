import { describe, it, expect, vi, afterEach } from 'vitest';
import { WebSocket as WsWebSocket } from 'ws';
import { createHarnessServer, type Agent, type HarnessServerHandle } from './server';
import { HarnessClient, type HarnessClientOptions } from './client';
import { ToolRegistry, type ToolDef } from './tools';
import type { AgentEvent } from './events';
import type { Message, ModelCallResult, ModelClient, ModelStreamHandlers } from './types';

class ScriptedModel implements ModelClient {
  constructor(private queue: ModelCallResult[]) {}
  async chat(_m: Message[], _t: unknown[], handlers?: ModelStreamHandlers): Promise<ModelCallResult> {
    const next = this.queue.shift();
    if (!next) throw new Error('out of scripted responses');
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

function timeAgent(handler = vi.fn(() => ({ iso: '2026-07-11T00:00:00Z' }))): { agent: Agent; handler: typeof handler } {
  const tools = new ToolRegistry();
  const def: ToolDef = {
    name: 'get_time',
    description: 'current time',
    mode: 'confirm',
    params: { type: 'object', properties: {}, additionalProperties: false },
    handler,
  };
  tools.register([def]);
  return { agent: { name: 'test', systemPrompt: 'sys', tools }, handler };
}

let server: HarnessServerHandle | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

function connectClient(port: number, options: HarnessClientOptions) {
  return new HarnessClient(`ws://127.0.0.1:${port}`, 'secret', {
    ...options,
    WebSocketImpl: WsWebSocket as any,
  });
}

describe('harness WebSocket server', () => {
  it('runs a gated tool over the wire after consent and streams the trace', async () => {
    const { agent, handler } = timeAgent();
    const model = new ScriptedModel([callTool('c1', 'get_time', {}), answer('it is midnight')]);
    server = await createHarnessServer({ model, agents: [agent], token: 'secret' });

    const events: AgentEvent[] = [];
    let finished: (v: unknown) => void;
    const done = new Promise((r) => (finished = r));

    let client: HarnessClient;
    client = connectClient(server.port, {
      handlers: {
        onEvent: (runId, event) => {
          events.push(event);
          if (event.type === 'consent.requested') client.decideConsent(runId, event.callId, true);
          if (event.type === 'run.finished') finished(event.result);
        },
      },
    });

    const agents = await client.connect();
    expect(agents).toEqual(['test']);

    client.startRun('what time is it?');
    const result = await done;

    expect(handler).toHaveBeenCalled();
    expect(result).toBe('it is midnight');
    const types = events.map((e) => e.type);
    expect(types).toContain('tool.requested');
    expect(types).toContain('consent.requested');
    expect(types).toContain('tool.finished');
    expect(events.some((e) => e.type === 'token')).toBe(true);
    client.close();
  });

  it('rejects a bad token', async () => {
    const { agent } = timeAgent();
    server = await createHarnessServer({ model: new ScriptedModel([]), agents: [agent], token: 'secret' });

    const errors: string[] = [];
    const raw = new WsWebSocket(`ws://127.0.0.1:${server.port}`);
    await new Promise<void>((resolve) => {
      raw.on('open', () => raw.send(JSON.stringify({ type: 'hello', token: 'WRONG' })));
      raw.on('message', (d) => {
        const msg = JSON.parse(d.toString());
        if (msg.type === 'error') {
          errors.push(msg.code);
          resolve();
        }
      });
    });
    expect(errors).toContain('unauthorized');
  });

  it('rejects a malformed message after auth with a typed error', async () => {
    const { agent } = timeAgent();
    server = await createHarnessServer({ model: new ScriptedModel([]), agents: [agent], token: 'secret' });

    const raw = new WsWebSocket(`ws://127.0.0.1:${server.port}`);
    const code = await new Promise<string>((resolve) => {
      let authed = false;
      raw.on('open', () => raw.send(JSON.stringify({ type: 'hello', token: 'secret' })));
      raw.on('message', (d) => {
        const msg = JSON.parse(d.toString());
        if (msg.type === 'ready') {
          authed = true;
          raw.send(JSON.stringify({ type: 'nonsense' }));
        } else if (authed && msg.type === 'error') {
          resolve(msg.code);
        }
      });
    });
    expect(code).toBe('bad_message');
    raw.close();
  });
});
