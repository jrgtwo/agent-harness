import { createRequire } from 'node:module';
import type * as Sqlite from 'node:sqlite';
import type { Message } from './types';

// node:sqlite is a newer builtin that bundlers (Vite/vitest) don't recognize; load it through the
// real require so it's left as a runtime builtin. Loaded lazily (in the constructor) so importing
// the harness barrel doesn't pull SQLite into clients that never open a Store.
function loadSqlite(): typeof Sqlite {
  return createRequire(import.meta.url)('node:sqlite') as typeof Sqlite;
}

// Persistence for agent-side state only: sessions, their messages, and config.
// Apps keep their own domain data — the harness does not store it.

export interface SessionInfo {
  id: string;
  title: string;
  agent: string | null;
  createdAt: number;
  updatedAt: number;
}

interface SessionRow {
  id: string;
  title: string;
  agent: string | null;
  created_at: number;
  updated_at: number;
}
interface MessageRow {
  role: string;
  content: string;
  tool_calls: string | null;
  tool_call_id: string | null;
}

export class Store {
  private db: Sqlite.DatabaseSync;

  /** `:memory:` (default) for tests; a file path for real persistence. */
  constructor(path = ':memory:') {
    const { DatabaseSync } = loadSqlite();
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id         TEXT PRIMARY KEY,
        title      TEXT NOT NULL DEFAULT '',
        agent      TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role         TEXT NOT NULL,
        content      TEXT NOT NULL,
        tool_calls   TEXT,
        tool_call_id TEXT,
        created_at   INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);
      CREATE TABLE IF NOT EXISTS config (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  getSession(id: string): SessionInfo | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as unknown as SessionRow | undefined;
    return row ? rowToSession(row) : undefined;
  }

  /** Get the session, creating it (with an optional title/agent) if it doesn't exist. */
  ensureSession(id: string, title = '', agent: string | null = null): SessionInfo {
    const existing = this.getSession(id);
    if (existing) return existing;
    const now = Date.now();
    this.db
      .prepare('INSERT INTO sessions (id, title, agent, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, title, agent, now, now);
    return { id, title, agent, createdAt: now, updatedAt: now };
  }

  listSessions(): SessionInfo[] {
    const rows = this.db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC').all() as unknown as SessionRow[];
    return rows.map(rowToSession);
  }

  deleteSession(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  touchSession(id: string): void {
    this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(Date.now(), id);
  }

  appendMessages(sessionId: string, messages: Message[]): void {
    const stmt = this.db.prepare(
      'INSERT INTO messages (session_id, role, content, tool_calls, tool_call_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const now = Date.now();
    for (const m of messages) {
      stmt.run(sessionId, m.role, m.content, m.toolCalls ? JSON.stringify(m.toolCalls) : null, m.toolCallId ?? null, now);
    }
  }

  getMessages(sessionId: string): Message[] {
    const rows = this.db
      .prepare('SELECT role, content, tool_calls, tool_call_id FROM messages WHERE session_id = ? ORDER BY id')
      .all(sessionId) as unknown as MessageRow[];
    return rows.map(rowToMessage);
  }

  getConfig(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM config WHERE key = ?').get(key) as unknown as
      | { value: string }
      | undefined;
    return row?.value;
  }

  setConfig(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  close(): void {
    this.db.close();
  }
}

function rowToSession(r: SessionRow): SessionInfo {
  return { id: r.id, title: r.title, agent: r.agent, createdAt: r.created_at, updatedAt: r.updated_at };
}

function rowToMessage(r: MessageRow): Message {
  const m: Message = { role: r.role as Message['role'], content: r.content };
  if (r.tool_calls) m.toolCalls = JSON.parse(r.tool_calls);
  if (r.tool_call_id) m.toolCallId = r.tool_call_id;
  return m;
}
