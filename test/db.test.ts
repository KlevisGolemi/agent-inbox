import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db/index.js'
import { LATEST_VERSION, MIGRATIONS, migrate } from '../src/db/migrations.js'
import { makeV1Db } from './fixtures/make-v1-db.js'

const EXPECTED_TABLES = [
  'admin_sessions',
  'api_keys',
  'attachments',
  'drop_events',
  'drop_tags',
  'drops',
  'message_tags',
  'messages',
  'oauth_clients',
  'oauth_codes',
  'oauth_tokens',
  'settings',
  'tags',
  'users',
]

const silent = (): void => {}

function tableNames(db: Database.Database): string[] {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as { name: string }[]
  return rows.map((r) => r.name)
}

describe('migrations', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-inbox-db-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('migre une base vierge jusqu’à la dernière version', () => {
    const db = openDb(':memory:')
    expect(LATEST_VERSION).toBe(4)
    expect(migrate(db, silent)).toBe(4)
    expect(db.pragma('user_version', { simple: true })).toBe(4)
    expect(tableNames(db)).toEqual(EXPECTED_TABLES)
  })

  it('est idempotente (deux appels)', () => {
    const db = openDb(':memory:')
    migrate(db, silent)
    expect(migrate(db, silent)).toBe(4)
    expect(db.pragma('user_version', { simple: true })).toBe(4)
  })

  it('reprend une base v1 sans perte', () => {
    const path = join(dir, 'v1.db')
    makeV1Db(path)
    const db = openDb(path)
    expect(db.pragma('user_version', { simple: true })).toBe(0)
    expect(migrate(db, silent)).toBe(4)

    const rows = db
      .prepare('SELECT id, payload, status, topic, attempts, lease_until FROM messages ORDER BY id')
      .all()
    expect(rows).toEqual([
      {
        id: 'm1',
        payload: '{"a":1}',
        status: 'pending',
        topic: 'default',
        attempts: 0,
        lease_until: null,
      },
      {
        id: 'm2',
        payload: '{"b":2}',
        status: 'pending',
        topic: 'default',
        attempts: 0,
        lease_until: null,
      },
      {
        id: 'm3',
        payload: '{"c":3}',
        status: 'read',
        topic: 'default',
        attempts: 0,
        lease_until: null,
      },
    ])

    const cols = db.prepare('PRAGMA table_info(messages)').all() as { name: string }[]
    expect(cols.map((c) => c.name)).toContain('correlation_id')

    const idx = db
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_correlation_id_unique'")
      .get() as { sql: string } | undefined
    expect(idx?.sql).toMatch(/UNIQUE/i)
    expect(idx?.sql).toMatch(/WHERE correlation_id IS NOT NULL/i)
    db.close()
  })

  it('reprend une base v1 qui a déjà correlation_id', () => {
    const path = join(dir, 'v1b.db')
    makeV1Db(path)
    const raw = new Database(path)
    raw.exec('ALTER TABLE messages ADD COLUMN correlation_id TEXT')
    raw.close()
    const db = openDb(path)
    expect(migrate(db, silent)).toBe(4)
    db.close()
  })

  it('migration 4 : base v3 peuplée → tables v4, message intact, trust internal', () => {
    const path = join(dir, 'v3.db')
    const db = openDb(path)
    expect(migrate(db, silent, MIGRATIONS.slice(0, 3))).toBe(3)
    db.prepare(
      `INSERT INTO messages (id, source, payload, status, created_at, topic, correlation_id)
       VALUES ('m1', 'n8n', '{"a":1}', 'pending', 1, 't', 'c1')`,
    ).run()
    expect(migrate(db, silent)).toBe(4)
    expect(
      db.prepare('SELECT payload, topic, correlation_id, trust, drop_id FROM messages').get(),
    ).toEqual({
      payload: '{"a":1}',
      topic: 't',
      correlation_id: 'c1',
      trust: 'internal',
      drop_id: null,
    })
    expect(tableNames(db)).toEqual(EXPECTED_TABLES)
    db.close()
  })

  it('migration 4 : supprimer un message supprime ses pièces et ses tags (cascade)', () => {
    const db = openDb(':memory:')
    migrate(db, silent)
    db.exec(`
      INSERT INTO tags (name, description, created_by, created_at) VALUES ('facture', 'Factures des clients', 't', 1);
      INSERT INTO messages (id, source, payload, status, created_at) VALUES ('m1', 't', '{}', 'pending', 1);
      INSERT INTO message_tags (message_id, tag) VALUES ('m1', 'facture');
      INSERT INTO attachments (id, message_id, filename, mime_type, category, size_bytes, sha256, created_at, expires_at)
        VALUES ('a1', 'm1', 'f.pdf', 'application/pdf', 'document', 3, 'x', 1, 2);
      DELETE FROM messages WHERE id = 'm1';
    `)
    const n = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n
    expect([n('attachments'), n('message_tags'), n('tags')]).toEqual([0, 0, 1])
  })

  it('migration 4 : renommer un tag suit dans message_tags et drop_tags (ON UPDATE CASCADE)', () => {
    const db = openDb(':memory:')
    migrate(db, silent)
    db.exec(`
      INSERT INTO tags (name, description, created_by, created_at) VALUES ('devis', 'Devis envoyés', 't', 1);
      INSERT INTO messages (id, source, payload, status, created_at) VALUES ('m1', 't', '{}', 'pending', 1);
      INSERT INTO message_tags (message_id, tag) VALUES ('m1', 'devis');
      INSERT INTO drops (id, token_hash, kind, label, topic, max_files, max_file_mb, allowed_categories, created_by, created_at, expires_at)
        VALUES ('d1', 'h', 'public', 'Photos', 'drops', 5, 10, '["image"]', 't', 1, 2);
      INSERT INTO drop_tags (drop_id, tag) VALUES ('d1', 'devis');
      UPDATE tags SET name = 'devis-client' WHERE name = 'devis';
    `)
    expect(db.prepare('SELECT tag FROM message_tags').get()).toEqual({ tag: 'devis-client' })
    expect(db.prepare('SELECT tag FROM drop_tags').get()).toEqual({ tag: 'devis-client' })
  })

  it('migration 4 : token_hash unique', () => {
    const db = openDb(':memory:')
    migrate(db, silent)
    const ins = db.prepare(
      `INSERT INTO drops (id, token_hash, kind, label, topic, max_files, max_file_mb, allowed_categories, created_by, created_at, expires_at)
       VALUES (?, 'same', 'public', 'L', 'drops', 1, 1, '[]', 't', 1, 2)`,
    )
    ins.run('d1')
    expect(() => ins.run('d2')).toThrow(/UNIQUE/)
  })

  it('annule la transaction si une migration lève', () => {
    const db = openDb(':memory:')
    const migrations = [
      { version: 1, up: (d: Database.Database) => void d.exec('CREATE TABLE a (x INTEGER)') },
      {
        version: 2,
        up: (d: Database.Database) => {
          d.exec('CREATE TABLE b (x INTEGER)')
          throw new Error('boom')
        },
      },
    ]
    expect(() => migrate(db, silent, migrations)).toThrow('boom')
    expect(db.pragma('user_version', { simple: true })).toBe(1)
    expect(tableNames(db)).toEqual(['a'])
  })
})

describe('openDb', () => {
  it('active foreign_keys, busy_timeout et WAL (fichier)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-inbox-db-'))
    try {
      const db = openDb(join(dir, 'q.db'))
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
      expect(db.pragma('busy_timeout', { simple: true })).toBe(5000)
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
      db.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
