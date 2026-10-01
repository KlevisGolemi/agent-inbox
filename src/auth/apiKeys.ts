import { randomInt } from 'node:crypto'
import type Database from 'better-sqlite3'
import { sha256 } from './tokens.js'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const KEY_RE = /^cwk_[A-Za-z0-9]{32}$/
const NAME_MAX = 100
const LAST_USED_THROTTLE_MS = 60_000

export interface ApiKeyInfo {
  id: number
  name: string
  prefix: string
  created_at: string
  last_used_at: string | null
  revoked: boolean
}

export interface ApiKeys {
  /** Crée une clé ; `key` n'est renvoyée qu'ici (seul son sha256 est stocké). */
  create(name: string): { id: number; key: string; prefix: string }
  list(): ApiKeyInfo[]
  /** false si la clé n'existe pas ou est déjà révoquée. */
  revoke(id: number): boolean
  /** null si la clé est mal formée, inconnue ou révoquée ; met à jour last_used_at au plus 1×/min. */
  verify(key: string): { id: number; name: string } | null
}

/** 32 caractères base62 via randomInt (pas de biais de modulo). */
function randomBase62(length: number): string {
  let out = ''
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)]
  return out
}

export function createApiKeys(db: Database.Database, now: () => number = Date.now): ApiKeys {
  const insert = db.prepare(
    'INSERT INTO api_keys (name, prefix, key_hash, created_at) VALUES (?, ?, ?, ?)',
  )
  const selectAll = db.prepare(
    'SELECT id, name, prefix, created_at, last_used_at, revoked FROM api_keys ORDER BY id',
  )
  const revokeStmt = db.prepare('UPDATE api_keys SET revoked = 1 WHERE id = ? AND revoked = 0')
  const selectByHash = db.prepare(
    'SELECT id, name, last_used_at FROM api_keys WHERE key_hash = ? AND revoked = 0',
  )
  const touch = db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?')

  return {
    create(name) {
      const trimmed = name.trim()
      if (trimmed.length < 1 || trimmed.length > NAME_MAX) {
        throw new Error(`Le nom de la clé doit contenir entre 1 et ${NAME_MAX} caractères.`)
      }
      const key = `cwk_${randomBase62(32)}`
      const prefix = key.slice(0, 8)
      const { lastInsertRowid } = insert.run(trimmed, prefix, sha256(key), now())
      return { id: Number(lastInsertRowid), key, prefix }
    },

    list() {
      const rows = selectAll.all() as {
        id: number
        name: string
        prefix: string
        created_at: number
        last_used_at: number | null
        revoked: number
      }[]
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        prefix: r.prefix,
        created_at: new Date(r.created_at).toISOString(),
        last_used_at: r.last_used_at === null ? null : new Date(r.last_used_at).toISOString(),
        revoked: r.revoked === 1,
      }))
    },

    revoke(id) {
      return revokeStmt.run(id).changes > 0
    },

    verify(key) {
      if (typeof key !== 'string' || !KEY_RE.test(key)) return null
      const row = selectByHash.get(sha256(key)) as
        { id: number; name: string; last_used_at: number | null } | undefined
      if (!row) return null
      const t = now()
      if (row.last_used_at === null || t - row.last_used_at >= LAST_USED_THROTTLE_MS) {
        touch.run(t, row.id)
      }
      return { id: row.id, name: row.name }
    },
  }
}
