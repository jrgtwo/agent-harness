import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { Store } from './store';
import type { Message } from '../core/types';

describe('Store', () => {
  it('creates a session once and is idempotent via ensureSession', () => {
    const s = new Store();
    s.ensureSession('s1', 'first title', 'assistant');
    const b = s.ensureSession('s1', 'ignored title');
    expect(b.id).toBe('s1');
    expect(b.title).toBe('first title'); // not overwritten
    expect(s.listSessions()).toHaveLength(1);
    s.close();
  });

  it('appends and reads back messages in order, preserving tool fields', () => {
    const s = new Store();
    s.ensureSession('s1');
    const msgs: Message[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'echo', arguments: '{"m":1}' }] },
      { role: 'tool', content: '{"ok":true}', toolCallId: 'c1' },
      { role: 'assistant', content: 'done' },
    ];
    s.appendMessages('s1', msgs);
    const read = s.getMessages('s1');
    expect(read).toEqual(msgs);
    s.close();
  });

  it('accumulates messages across multiple appends (multi-turn)', () => {
    const s = new Store();
    s.ensureSession('s1');
    s.appendMessages('s1', [{ role: 'user', content: 'turn 1' }]);
    s.appendMessages('s1', [{ role: 'user', content: 'turn 2' }]);
    expect(s.getMessages('s1').map((m) => m.content)).toEqual(['turn 1', 'turn 2']);
    s.close();
  });

  it('cascade-deletes a session and its messages', () => {
    const s = new Store();
    s.ensureSession('s1');
    s.appendMessages('s1', [{ role: 'user', content: 'x' }]);
    s.deleteSession('s1');
    expect(s.getSession('s1')).toBeUndefined();
    expect(s.getMessages('s1')).toEqual([]);
    s.close();
  });

  it('upserts config', () => {
    const s = new Store();
    s.setConfig('model', 'a');
    s.setConfig('model', 'b');
    expect(s.getConfig('model')).toBe('b');
    expect(s.getConfig('missing')).toBeUndefined();
    s.close();
  });

  it('persists across reopen when backed by a file', () => {
    const path = join(tmpdir(), `harness-store-test-${process.pid}-${Date.now()}.sqlite`);
    try {
      const s1 = new Store(path);
      s1.ensureSession('s1', 'kept');
      s1.appendMessages('s1', [{ role: 'user', content: 'remember me' }]);
      s1.close();

      const s2 = new Store(path);
      expect(s2.getSession('s1')?.title).toBe('kept');
      expect(s2.getMessages('s1')[0]?.content).toBe('remember me');
      s2.close();
    } finally {
      rmSync(path, { force: true });
    }
  });
});
