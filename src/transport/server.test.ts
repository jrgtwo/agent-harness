import { describe, it, expect, vi, afterEach } from 'vitest';
import { WebSocket as WsWebSocket } from 'ws';
import { createHarnessServer, type Agent, type HarnessServerHandle } from './server';
import { HarnessClient, type HarnessClientOptions } from './client';
import { ToolRegistry, type ToolDef } from '../agent/tools';
import { Store } from '../store/store';
import type { AgentEvent } from '../core/events';
import type { Message, ModelCallResult, ModelClient, ModelStreamHandlers } from '../core/types';

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

function timeAgent(handler = vi.fn(() => ({ iso: '2026-07-11T00:00:00Z' }))): {
  agent: Agent;
  handler: typeof handler;
} {
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

    const client = connectClient(server.port, {
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

  const playerDecl = {
    name: 'select_player',
    description: 'pull up a player in the UI and return their stat line',
    params: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    mode: 'confirm' as const,
  };

  it('routes a client-declared tool to the app after consent and feeds its result back', async () => {
    const { agent } = timeAgent();
    const model = new ScriptedModel([callTool('c1', 'select_player', { name: 'Josh Allen' }), answer('Allen looks strong')]);
    server = await createHarnessServer({ model, agents: [agent], token: 'secret' });

    const invoked: { runId: string; callId: string; name: string; args: unknown }[] = [];
    let finished: (v: unknown) => void;
    const done = new Promise((r) => (finished = r));

    const client = connectClient(server.port, {
      clientTools: [playerDecl],
      handlers: {
        onEvent: (runId, event) => {
          if (event.type === 'consent.requested') client.decideConsent(runId, event.callId, true);
          if (event.type === 'run.finished') finished(event.result);
        },
        onToolInvoke: (req) => {
          invoked.push(req);
          client.respondTool(req.runId, req.callId, { player: req.args, fantasyPointsPpr: 320 });
        },
      },
    });

    await client.connect();
    client.startRun('evaluate a player', { agent: 'test' });
    const result = await done;

    expect(result).toBe('Allen looks strong');
    expect(invoked).toHaveLength(1);
    expect(invoked[0]).toMatchObject({ name: 'select_player', args: { name: 'Josh Allen' } });
    client.close();
  });

  it('does not invoke the app when the user denies a client tool, and feeds a denial back', async () => {
    const { agent } = timeAgent();
    const model = new ScriptedModel([callTool('c1', 'select_player', { name: 'X' }), answer('ok, skipped it')]);
    server = await createHarnessServer({ model, agents: [agent], token: 'secret' });

    const invoked: unknown[] = [];
    const consentNames: string[] = [];
    let finished: (v: unknown) => void;
    const done = new Promise((r) => (finished = r));

    const client = connectClient(server.port, {
      clientTools: [playerDecl],
      handlers: {
        onEvent: (runId, event) => {
          if (event.type === 'consent.requested') {
            consentNames.push(event.name);
            client.decideConsent(runId, event.callId, false);
          }
          if (event.type === 'run.finished') finished(event.result);
        },
        onToolInvoke: (req) => {
          invoked.push(req);
          client.respondTool(req.runId, req.callId, {});
        },
      },
    });

    await client.connect();
    client.startRun('evaluate a player', { agent: 'test' });
    const result = await done;

    expect(result).toBe('ok, skipped it');
    expect(consentNames).toContain('select_player'); // the client tool was gated through consent
    expect(invoked).toHaveLength(0); // denied before ever reaching the app
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

  it('threads prior session history into a later run when a store is used', async () => {
    const seen: Message[][] = [];
    const model: ModelClient = {
      async chat(messages) {
        seen.push(structuredClone(messages));
        return answer('ok');
      },
    };
    const { agent } = timeAgent();
    const store = new Store();
    server = await createHarnessServer({ model, agents: [agent], token: 'secret', store });

    const finishers = new Map<string, () => void>();
    const client = connectClient(server.port, {
      handlers: {
        onEvent: (runId, event) => {
          if (event.type === 'run.finished') finishers.get(runId)?.();
        },
      },
    });
    await client.connect();

    const runOnce = (input: string) => {
      const runId = crypto.randomUUID();
      const done = new Promise<void>((res) => finishers.set(runId, res));
      client.startRun(input, { runId, sessionId: 's1' });
      return done;
    };

    await runOnce('my name is Jon');
    await runOnce('what is my name?');

    const second = seen[1]!;
    expect(second.some((m) => m.role === 'user' && m.content === 'my name is Jon')).toBe(true);
    expect(second.some((m) => m.role === 'assistant' && m.content === 'ok')).toBe(true);
    expect(second.some((m) => m.role === 'user' && m.content === 'what is my name?')).toBe(true);
    expect(store.getMessages('s1')).toHaveLength(4); // 2 user + 2 assistant
    client.close();
  });
});
