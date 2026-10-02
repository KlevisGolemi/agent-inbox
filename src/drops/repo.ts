import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { FileCategory, OnDownload } from '../files/types.js'
import { createTags, type NewTag } from '../tags/attach.js'

export type DropKind = 'public' | 'self'
export type DropStatus = 'active' | 'expired' | 'revoked' | 'exhausted' | 'used'

export interface DropRow {
  id: string
  token_hash: string
  kind: DropKind
  label: string
  topic: string
  max_files: number
  files_count: number
  max_file_mb: number
  allowed_categories: string
  message_payload: string | null
  correlation_id: string | null
  on_download: OnDownload | null
  created_by: string
  created_at: number
  expires_at: number
  revoked_at: number | null
}

export interface DropView {
  id: string
  kind: DropKind
  label: string
  topic: string
  tags: string[]
  max_files: number
  files_count: number
  max_file_mb: number
  allowed_categories: FileCategory[]
  correlation_id: string | null
  on_download: OnDownload | null
  created_by: string
  created_at: string
  expires_at: string
  revoked_at: string | null
  status: DropStatus
}

export interface DropEvent {
  at: string
  outcome: string
  files: number
  bytes: number
  message_id: string | null
}

export interface CreateDropInput {
  kind: DropKind
  label: string
  topic: string
  /** Tags déjà au registre (validés par l'appelant). */
  tags: string[]
  /** Tags validés à créer dans la même transaction que le lien (aucun orphelin si l'insertion échoue). */
  newTags?: NewTag[]
  maxFiles: number
  maxFileMb: number
  allowedCategories: FileCategory[]
  expiresAt: number
  createdBy: string
  messagePayload?: Record<string, unknown> | null
  correlationId?: string | null
  onDownload?: OnDownload | null
}

export interface DropsRepo {
  create(input: CreateDropInput): { drop: DropView; token: string }
  /** Recherche par sha256 du jeton ; ne renvoie qu'un lien utilisable (ni révoqué, ni expiré, ni épuisé). */
  findActiveByToken(token: string): DropRow | null
  /** Lien self : le réserve pour UNE requête (`at` sert de jeton de requête). */
  claimSelf(id: string, at: number): boolean
  /** Échec de la requête : le lien redevient utilisable (seulement si `at` est encore le sien). */
  releaseSelf(id: string, at: number): void
  /** Une place par fichier, en un seul UPDATE … RETURNING. */
  reserveSlot(id: string, claimAt: number | null): boolean
  releaseSlots(id: string, n: number): void
  addEvent(e: {
    dropId: string
    outcome: string
    files: number
    bytes: number
    messageId: string | null
  }): void
  events(dropId: string, limit?: number): DropEvent[]
  list(opts?: { includeExpired?: boolean }): DropView[]
  get(id: string): DropView | null
  tagsOf(id: string): string[]
  revoke(id: string): boolean
}

/** Seul le sha256 du jeton est stocké ; la recherche se fait par hash (index unique). */
export const hashDropToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex')
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString())

export function createDropsRepo(
  db: Database.Database,
  opts: { now?: () => number } = {},
): DropsRepo {
  const now = opts.now ?? Date.now
  const byId = db.prepare('SELECT * FROM drops WHERE id = ?')
  const tagsStmt = db.prepare('SELECT tag FROM drop_tags WHERE drop_id = ? ORDER BY tag')
  const tagsOf = (id: string) => (tagsStmt.all(id) as { tag: string }[]).map((r) => r.tag)

  function status(r: DropRow): DropStatus {
    if (r.revoked_at !== null) return r.kind === 'self' && r.files_count > 0 ? 'used' : 'revoked'
    if (r.expires_at <= now()) return 'expired'
    return r.files_count >= r.max_files ? 'exhausted' : 'active'
  }
  const view = (r: DropRow): DropView => ({
    id: r.id,
    kind: r.kind,
    label: r.label,
    topic: r.topic,
    tags: tagsOf(r.id),
    max_files: r.max_files,
    files_count: r.files_count,
    max_file_mb: r.max_file_mb,
    allowed_categories: JSON.parse(r.allowed_categories) as FileCategory[],
    correlation_id: r.correlation_id,
    on_download: r.on_download,
    created_by: r.created_by,
    created_at: new Date(r.created_at).toISOString(),
    expires_at: new Date(r.expires_at).toISOString(),
    revoked_at: iso(r.revoked_at),
    status: status(r),
  })

  return {
    create(input) {
      const id = randomUUID()
      const token = randomBytes(32).toString('base64url') // 256 bits, montré une seule fois
      const t = now()
      db.transaction(() => {
        createTags(db, input.newTags ?? [], t)
        db.prepare(
          `INSERT INTO drops (id, token_hash, kind, label, topic, max_files, max_file_mb, allowed_categories,
             message_payload, correlation_id, on_download, created_by, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          hashDropToken(token),
          input.kind,
          input.label,
          input.topic,
          input.maxFiles,
          input.maxFileMb,
          JSON.stringify(input.allowedCategories),
          input.messagePayload ? JSON.stringify(input.messagePayload) : null,
          input.correlationId ?? null,
          input.onDownload ?? null,
          input.createdBy,
          t,
          input.expiresAt,
        )
        const tag = db.prepare('INSERT OR IGNORE INTO drop_tags (drop_id, tag) VALUES (?, ?)')
        for (const name of [...input.tags, ...(input.newTags ?? []).map((n) => n.name)])
          tag.run(id, name)
      })()
      return { drop: view(byId.get(id) as DropRow), token }
    },
    findActiveByToken(token) {
      return (
        (db
          .prepare(
            `SELECT * FROM drops WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ? AND files_count < max_files`,
          )
          .get(hashDropToken(token), now()) as DropRow | undefined) ?? null
      )
    },
    claimSelf(id, at) {
      return (
        db
          .prepare(
            `UPDATE drops SET revoked_at = :at
              WHERE id = :id AND kind = 'self' AND revoked_at IS NULL AND expires_at > :at RETURNING id`,
          )
          .get({ id, at }) !== undefined
      )
    },
    releaseSelf(id, at) {
      db.prepare('UPDATE drops SET revoked_at = NULL WHERE id = ? AND revoked_at = ?').run(id, at)
    },
    reserveSlot(id, claimAt) {
      return (
        db
          .prepare(
            `UPDATE drops SET files_count = files_count + 1
              WHERE id = :id AND files_count < max_files AND expires_at > :now
                AND (revoked_at IS NULL OR (kind = 'self' AND :claim IS NOT NULL AND revoked_at = :claim))
              RETURNING files_count`,
          )
          .get({ id, now: now(), claim: claimAt }) !== undefined
      )
    },
    releaseSlots(id, n) {
      if (n > 0)
        db.prepare('UPDATE drops SET files_count = MAX(files_count - ?, 0) WHERE id = ?').run(n, id)
    },
    addEvent(e) {
      db.prepare(
        'INSERT INTO drop_events (drop_id, at, outcome, files, bytes, message_id) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(e.dropId, now(), e.outcome, e.files, e.bytes, e.messageId)
    },
    events(dropId, limit = 100) {
      return (
        db
          .prepare(
            'SELECT at, outcome, files, bytes, message_id FROM drop_events WHERE drop_id = ? ORDER BY id DESC LIMIT ?',
          )
          .all(dropId, limit) as {
          at: number
          outcome: string
          files: number
          bytes: number
          message_id: string | null
        }[]
      ).map((r) => ({ ...r, at: new Date(r.at).toISOString() }))
    },
    list({ includeExpired = false } = {}) {
      const rows = includeExpired
        ? db.prepare('SELECT * FROM drops ORDER BY created_at DESC LIMIT 200').all()
        : db
            .prepare(
              'SELECT * FROM drops WHERE revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 200',
            )
            .all(now())
      return (rows as DropRow[]).map(view)
    },
    get(id) {
      const r = byId.get(id) as DropRow | undefined
      return r ? view(r) : null
    },
    tagsOf,
    revoke(id) {
      return (
        db
          .prepare('UPDATE drops SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
          .run(now(), id).changes > 0
      )
    },
  }
}
