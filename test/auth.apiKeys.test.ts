import type Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApiKeys } from '../src/auth/apiKeys.js'
import { sha256 } from '../src/auth/tokens.js'
import { openDb } from '../src/db/index.js'
import { migrate } from '../src/db/migrations.js'

let db: Database.Database
let clock = 1_700_000_000_000
const now = () => clock

beforeEach(() => {
  db = openDb(':memory:')
  migrate(db, () => {})
  clock = 1_700_000_000_000
})

describe('clés API', () => {
  it('génère une clé au bon format et ne stocke que son hachage', () => {
    const keys = createApiKeys(db, now)
    const { id, key, prefix } = keys.create('  Claude Desktop  ')
    expect(key).toMatch(/^cwk_[A-Za-z0-9]{32}$/)
    expect(prefix).toBe(key.slice(0, 8))
    const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id) as Record<string, unknown>
    expect(row.key_hash).toBe(sha256(key))
    expect(row.key_hash).not.toBe(key)
    expect(JSON.stringify(row)).not.toContain(key)
    expect(row.name).toBe('Claude Desktop')
  })

  it('refuse un nom vide ou trop long', () => {
    const keys = createApiKeys(db, now)
    expect(() => keys.create('   ')).toThrow(/nom/i)
    expect(() => keys.create('x'.repeat(101))).toThrow(/100/)
    expect(() => keys.create('x'.repeat(100))).not.toThrow()
  })

  it('verify accepte une clé valide', () => {
    const keys = createApiKeys(db, now)
    const { id, key } = keys.create('a')
    expect(keys.verify(key)).toEqual({ id, name: 'a' })
  })

  it('verify renvoie null pour clé inconnue, mal formée ou révoquée', () => {
    const keys = createApiKeys(db, now)
    const { id, key } = keys.create('a')
    expect(keys.verify('cwk_' + 'A'.repeat(32))).toBeNull()
    expect(keys.verify('cwk_court')).toBeNull()
    expect(keys.verify(key + 'x')).toBeNull()
    expect(keys.verify('')).toBeNull()
    expect(keys.revoke(id)).toBe(true)
    expect(keys.verify(key)).toBeNull()
    expect(keys.revoke(id)).toBe(false)
    expect(keys.revoke(9999)).toBe(false)
  })

  it('met à jour last_used_at au plus une fois par minute', () => {
    const keys = createApiKeys(db, now)
    const { id, key } = keys.create('a')
    const last = () =>
      (
        db.prepare('SELECT last_used_at FROM api_keys WHERE id = ?').get(id) as {
          last_used_at: number | null
        }
      ).last_used_at
    expect(last()).toBeNull()
    keys.verify(key)
    expect(last()).toBe(clock)
    const first = clock
    clock += 59_000
    keys.verify(key)
    expect(last()).toBe(first)
    clock += 1_000
    keys.verify(key)
    expect(last()).toBe(clock)
  })

  it('list renvoie des dates ISO sans jamais exposer la clé', () => {
    const keys = createApiKeys(db, now)
    const a = keys.create('a')
    const b = keys.create('b')
    keys.revoke(b.id)
    keys.verify(a.key)
    const list = keys.list()
    expect(list).toHaveLength(2)
    expect(list[0]).toEqual({
      id: a.id,
      name: 'a',
      prefix: a.prefix,
      created_at: new Date(clock).toISOString(),
      last_used_at: new Date(clock).toISOString(),
      revoked: false,
    })
    expect(list[1]).toMatchObject({ id: b.id, revoked: true, last_used_at: null })
    expect(JSON.stringify(list)).not.toContain(a.key)
  })
})
