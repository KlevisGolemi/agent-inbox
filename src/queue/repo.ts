import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { log } from '../log.js'

export type MessageStatus = 'pending' | 'leased' | 'read'

export type QueueItem = {
  id: string
  source: string
  correlation_id: string | null
  topic: string
  status: MessageStatus
  created_at: string
  read_at: string | null
  lease_until: string | null
  /** `<uuid>.<attempts>` quand le message est emprunté, sinon null. */
  lease_id: string | null
  attempts: number
  payload: unknown
}

export type Stats = { total: number; pending: number; read_count: number }
export type FullStats = Stats & { leased: number; topics: Record<string, number> }

export type SearchFilter = {
  topic?: string
  source?: string
  status?: MessageStatus
  since?: number
  until?: number
  text?: string
  limit?: number
}

export type ClaimByCorrelation =
  | { item: QueueItem }
  | { error: 'not_found' }
  | { error: 'already_read'; id: string; read_at: string | null }
  | { error: 'leased'; lease_until: string }

export type AckResult = 'ok' | 'not_found' | 'not_leased' | 'invalid_lease'

export type EnqueueResult =
  | { ok: true; id: string; pending: number }
  | { ok: false; error: 'duplicate_correlation_id'; existingId: string | null }

export interface QueueRepo {
  enqueue(input: {
    payload: unknown
    source: string
    correlationId: string | null
    topic?: string
  }): EnqueueResult
  claimNext(opts?: { topic?: string; lease?: boolean }): QueueItem | null
  claimByCorrelation(cid: string, opts?: { lease?: boolean }): ClaimByCorrelation
  findByCorrelation(cid: string): QueueItem | null
  ack(leaseId: string): AckResult
  nack(leaseId: string): AckResult
  peek(limit: number, offset: number, opts?: { topic?: string }): QueueItem[]
  search(f: SearchFilter): QueueItem[]
  stats(opts?: { topic?: string }): FullStats
  deleteById(id: string): boolean
  clear(): number
  deleteExpired(
    cutoffMs: number,
    overrides: Record<string, number>,
    now: number,
  ): { read: number; pending: number }
  onEnqueue(listener: (item: QueueItem) => void): () => void
}

export interface QueueRepoOptions {
  /** Horloge injectable (tests). */
  now?: () => number
  /** Durée du bail en ms, relue à chaque emprunt. */
  leaseTimeoutMs?: () => number
}

type Row = {
  id: string
  source: string
  payload: string
  status: MessageStatus
  topic: string
  created_at: number
  read_at: number | null
  lease_until: number | null
  attempts: number
  correlation_id: string | null
}

const COLS =
  'id, source, payload, status, topic, created_at, read_at, lease_until, attempts, correlation_id'
/** `<uuid>.<attempts>` : UUID (insensible à la casse) et tentatives entières ≥ 1 sans zéro initial. */
const LEASE_ID_REGEX =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([1-9]\d{0,8})$/i
const HOUR_MS = 3_600_000
const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString())

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    log('warn', 'payload JSON corrompu : renvoi brut')
    return { __corrupted: true, raw }
  }
}

function toItem(r: Row): QueueItem {
  return {
    id: r.id,
    source: r.source,
    correlation_id: r.correlation_id,
    topic: r.topic,
    status: r.status,
    created_at: new Date(r.created_at).toISOString(),
    read_at: iso(r.read_at),
    lease_until: iso(r.lease_until),
    lease_id: r.status === 'leased' ? `${r.id}.${r.attempts}` : null,
    attempts: r.attempts,
    payload: safeParse(r.payload),
  }
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`)

export function createQueueRepo(db: Database.Database, options: QueueRepoOptions = {}): QueueRepo {
  const now = options.now ?? Date.now
  const leaseTimeoutMs = options.leaseTimeoutMs ?? (() => 300_000)
  const listeners = new Set<(item: QueueItem) => void>()

  const insert = db.prepare(
    `INSERT INTO messages (id, source, payload, status, created_at, correlation_id, topic)
     VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
  )
  const selectById = db.prepare(`SELECT ${COLS} FROM messages WHERE id = ?`)
  const selectByCid = db.prepare(`SELECT ${COLS} FROM messages WHERE correlation_id = ?`)
  const countPending = db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE status = 'pending'`)

  // Claim atomique : un seul UPDATE … RETURNING, sûr entre connexions concurrentes.
  // Éligible : pending, ou leased dont le bail est expiré.
  const READ_ASSIGN = `status = 'read', read_at = :now, lease_until = NULL`
  const LEASE_ASSIGN = `status = 'leased', lease_until = :lease_until, attempts = attempts + 1`
  const claimSql = (assign: string) => `
    UPDATE messages SET ${assign}
     WHERE id = (
       SELECT id FROM messages
        WHERE (:topic IS NULL OR topic = :topic)
          AND (status = 'pending' OR (status = 'leased' AND lease_until <= :now))
        ORDER BY created_at ASC, rowid ASC
        LIMIT 1
     )
    RETURNING ${COLS}`
  const claimRead = db.prepare(claimSql(READ_ASSIGN))
  const claimLease = db.prepare(claimSql(LEASE_ASSIGN))

  const cidSql = (assign: string) => `
    UPDATE messages SET ${assign}
     WHERE correlation_id = :cid
       AND (status = 'pending' OR (status = 'leased' AND lease_until <= :now))
    RETURNING ${COLS}`
  const cidRead = db.prepare(cidSql(READ_ASSIGN))
  const cidLease = db.prepare(cidSql(LEASE_ASSIGN))

  const ackStmt = db.prepare(
    `UPDATE messages SET status = 'read', read_at = ?, lease_until = NULL WHERE id = ? AND attempts = ? AND status = 'leased'`,
  )
  const nackStmt = db.prepare(
    `UPDATE messages SET status = 'pending', lease_until = NULL WHERE id = ? AND attempts = ? AND status = 'leased'`,
  )
  const existsStmt = db.prepare('SELECT 1 FROM messages WHERE id = ?')

  function claimParams(lease: boolean, t: number): Record<string, unknown> {
    return lease ? { now: t, lease_until: t + leaseTimeoutMs() } : { now: t }
  }

  // Un bail se désigne par `<uuid>.<attempts>` : un ré-emprunt incrémente attempts, ce qui
  // invalide l'ancien lease_id. Un bail expiré mais non ré-emprunté reste acquittable.
  function transition(kind: 'ack' | 'nack', leaseId: string): AckResult {
    const m = LEASE_ID_REGEX.exec(leaseId)
    if (!m) return 'invalid_lease'
    const id = m[1]!.toLowerCase()
    const attempts = Number(m[2])
    const info = kind === 'ack' ? ackStmt.run(now(), id, attempts) : nackStmt.run(id, attempts)
    if (info.changes > 0) return 'ok'
    return existsStmt.get(id) ? 'not_leased' : 'not_found'
  }

  return {
    enqueue({ payload, source, correlationId, topic }) {
      const id = randomUUID()
      try {
        insert.run(
          id,
          source,
          JSON.stringify(payload ?? {}),
          now(),
          correlationId,
          topic ?? 'default',
        )
      } catch (err) {
        if (
          (err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE' &&
          correlationId !== null
        ) {
          const existing = selectByCid.get(correlationId) as Row | undefined
          return { ok: false, error: 'duplicate_correlation_id', existingId: existing?.id ?? null }
        }
        throw err
      }
      const item = toItem(selectById.get(id) as Row)
      for (const l of [...listeners]) {
        try {
          l(item)
        } catch (e) {
          log('error', 'écouteur onEnqueue en échec', { error: String(e) })
        }
      }
      return { ok: true, id, pending: (countPending.get() as { n: number }).n }
    },

    claimNext(opts = {}) {
      const lease = opts.lease === true
      const row = (lease ? claimLease : claimRead).get({
        topic: opts.topic ?? null,
        ...claimParams(lease, now()),
      }) as Row | undefined
      return row ? toItem(row) : null
    },

    claimByCorrelation(cid, opts = {}) {
      const lease = opts.lease === true
      const row = (lease ? cidLease : cidRead).get({ cid, ...claimParams(lease, now()) }) as
        Row | undefined
      if (row) return { item: toItem(row) }
      const existing = selectByCid.get(cid) as Row | undefined
      if (!existing) return { error: 'not_found' }
      if (existing.status === 'leased')
        return { error: 'leased', lease_until: iso(existing.lease_until)! }
      return { error: 'already_read', id: existing.id, read_at: iso(existing.read_at) }
    },

    findByCorrelation(cid) {
      const row = selectByCid.get(cid) as Row | undefined
      return row ? toItem(row) : null
    },

    ack: (id) => transition('ack', id),
    nack: (id) => transition('nack', id),

    peek(limit, offset, opts = {}) {
      const rows = db
        .prepare(
          `SELECT ${COLS} FROM messages WHERE (:topic IS NULL OR topic = :topic)
           ORDER BY created_at DESC, rowid DESC LIMIT :limit OFFSET :offset`,
        )
        .all({ topic: opts.topic ?? null, limit, offset }) as Row[]
      return rows.map(toItem)
    },

    search(f) {
      const where: string[] = []
      const params: Record<string, unknown> = { limit: f.limit ?? 50 }
      const add = (clause: string, key: string, value: unknown) => {
        where.push(clause)
        params[key] = value
      }
      if (f.topic !== undefined) add('topic = :topic', 'topic', f.topic)
      if (f.source !== undefined) add('source = :source', 'source', f.source)
      if (f.status !== undefined) add('status = :status', 'status', f.status)
      if (f.since !== undefined) add('created_at >= :since', 'since', f.since)
      if (f.until !== undefined) add('created_at <= :until', 'until', f.until)
      if (f.text !== undefined)
        add(`payload LIKE :text ESCAPE '\\'`, 'text', `%${escapeLike(f.text)}%`)
      const sql = `SELECT ${COLS} FROM messages ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                   ORDER BY created_at DESC, rowid DESC LIMIT :limit`
      return (db.prepare(sql).all(params) as Row[]).map(toItem)
    },

    stats(opts = {}) {
      const topic = opts.topic ?? null
      const totals = db
        .prepare(
          `SELECT COUNT(*) AS total,
                  COALESCE(SUM(status = 'pending'), 0) AS pending,
                  COALESCE(SUM(status = 'leased'), 0) AS leased,
                  COALESCE(SUM(status = 'read'), 0) AS read_count
             FROM messages WHERE (:topic IS NULL OR topic = :topic)`,
        )
        .get({ topic }) as { total: number; pending: number; leased: number; read_count: number }
      const byTopic = db
        .prepare(
          `SELECT topic, COUNT(*) AS n FROM messages WHERE (:topic IS NULL OR topic = :topic) GROUP BY topic`,
        )
        .all({ topic }) as { topic: string; n: number }[]
      return { ...totals, topics: Object.fromEntries(byTopic.map((r) => [r.topic, r.n])) }
    },

    deleteById(id) {
      return db.prepare('DELETE FROM messages WHERE id = ?').run(id).changes > 0
    },

    clear() {
      return db.prepare('DELETE FROM messages').run().changes
    },

    deleteExpired(cutoffMs, overrides, nowMs) {
      const delRead = (cond: string) =>
        `DELETE FROM messages WHERE status = 'read' AND read_at < ? AND ${cond}`
      const delOpen = (cond: string) =>
        `DELETE FROM messages WHERE status != 'read' AND created_at < ? AND ${cond}`
      const topics = Object.keys(overrides)
      const notIn = topics.length ? `topic NOT IN (${topics.map(() => '?').join(',')})` : '1 = 1'
      return db.transaction(() => {
        let read = db.prepare(delRead(notIn)).run(cutoffMs, ...topics).changes
        let pending = db.prepare(delOpen(notIn)).run(cutoffMs, ...topics).changes
        for (const topic of topics) {
          const cut = nowMs - overrides[topic]! * HOUR_MS
          read += db.prepare(delRead('topic = ?')).run(cut, topic).changes
          pending += db.prepare(delOpen('topic = ?')).run(cut, topic).changes
        }
        return { read, pending }
      })()
    },

    onEnqueue(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
