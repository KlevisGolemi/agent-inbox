import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db/index.js'
import { LATEST_VERSION, migrate } from '../src/db/migrations.js'
import { makeV1Db } from './fixtures/make-v1-db.js'

const EXPECTED_TABLES = [
  'admin_sessions',
  'api_keys',
  'messages',
  'oauth_clients',
  'oauth_codes',
  'oauth_tokens',
  'settings',
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
    dir = mkdtempSync(join(tmpdir(), 'cowork-db-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('migre une base vierge jusqu’à la dernière version', () => {
    const db = openDb(':memory:')
    expect(LATEST_VERSION).toBe(3)
    expect(migrate(db, silent)).toBe(3)
    expect(db.pragma('user_version', { simple: true })).toBe(3)
    expect(tableNames(db)).toEqual(EXPECTED_TABLES)
  })

  it('est idempotente (deux appels)', () => {
    const db = openDb(':memory:')
    migrate(db, silent)
    expect(migrate(db, silent)).toBe(3)
    expect(db.pragma('user_version', { simple: true })).toBe(3)
  })

  it('reprend une base v1 sans perte', () => {
    const path = join(dir, 'v1.db')
    makeV1Db(path)
    const db = openDb(path)
    expect(db.pragma('user_version', { simple: true })).toBe(0)
    expect(migrate(db, silent)).toBe(3)

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
    expect(migrate(db, silent)).toBe(3)
    db.close()
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
    const dir = mkdtempSync(join(tmpdir(), 'cowork-db-'))
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
