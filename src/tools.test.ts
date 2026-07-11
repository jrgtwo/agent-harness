import { describe, it, expect } from 'vitest';
import { ToolRegistry, type ToolDef } from './tools';

const echo: ToolDef = {
  name: 'echo',
  description: 'echo a message',
  mode: 'confirm',
  params: {
    type: 'object',
    properties: { msg: { type: 'string' } },
    required: ['msg'],
    additionalProperties: false,
  },
  handler: (args: { msg: string }) => ({ echoed: args.msg }),
};

describe('ToolRegistry', () => {
  it('registers, looks up, and exposes model schemas', () => {
    const r = new ToolRegistry();
    r.register([echo]);
    expect(r.get('echo')).toBe(echo);
    expect(r.names()).toEqual(['echo']);
    expect(r.schemas()).toEqual([
      { name: 'echo', description: 'echo a message', parameters: echo.params },
    ]);
  });

  it('validates good args', () => {
    const r = new ToolRegistry();
    r.register([echo]);
    expect(r.validate('echo', { msg: 'hi' })).toEqual({ ok: true });
  });

  it('rejects args missing a required field with a readable error', () => {
    const r = new ToolRegistry();
    r.register([echo]);
    const res = r.validate('echo', {});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors).toMatch(/msg/);
  });

  it('rejects wrong types and extra properties', () => {
    const r = new ToolRegistry();
    r.register([echo]);
    expect(r.validate('echo', { msg: 42 }).ok).toBe(false);
    expect(r.validate('echo', { msg: 'hi', extra: 1 }).ok).toBe(false);
  });
});
