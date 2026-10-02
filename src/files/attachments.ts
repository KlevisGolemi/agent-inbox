import type Database from 'better-sqlite3'
import type { Settings } from '../settings/index.js'
import { computeExpiresAt } from './retention.js'
import type { FileStore } from './store.js'
import type { AttachmentStatus, DeletedReason, FileCategory, OnDownload } from './types.js'
import type { StagedFile } from './uploads.js'

export interface AttachmentRow {
  id: string
  message_id: string
  filename: string
  mime_type: string
  category: FileCategory
  size_bytes: number
  sha256: string
  on_download: OnDownload
  created_at: number
  expires_at: number
  downloads: number
  first_downloaded_at: number | null
  deleted_at: number | null
  deleted_reason: DeletedReason | null
  message_trust: 'internal' | 'external'
}

export interface AttachmentView {
  id: string
  filename: string
  mime_type: string
  category: FileCategory
  size_bytes: number
  sha256: string
  on_download: OnDownload
  expires_at: string
  status: AttachmentStatus
}

export interface NewAttachment {
  id: string
  filename: string
  mime_type: string
  category: FileCategory
  size_bytes: number
  sha256: string
  on_download: OnDownload
  expires_at: number
}

export interface AttachmentsRepo {
  get(id: string): AttachmentRow | null
  forMessage(messageId: string): AttachmentRow[]
  status(row: AttachmentRow): AttachmentStatus
  view(row: AttachmentRow): AttachmentView
  recordDelivery(id: string): void
}

const COLS = `a.id, a.message_id, a.filename, a.mime_type, a.category, a.size_bytes, a.sha256, a.on_download,
  a.created_at, a.expires_at, a.downloads, a.first_downloaded_at, a.deleted_at, a.deleted_reason, m.trust AS message_trust`
const DEFAULT_GRACE_MIN = 10

export function createAttachmentsRepo(
  db: Database.Database,
  opts: { files?: FileStore; settings?: Settings; now?: () => number } = {},
): AttachmentsRepo {
  const now = opts.now ?? Date.now
  const byId = db.prepare(
    `SELECT ${COLS} FROM attachments a JOIN messages m ON m.id = a.message_id WHERE a.id = ?`,
  )
  const byMessage = db.prepare(
    `SELECT ${COLS} FROM attachments a JOIN messages m ON m.id = a.message_id
      WHERE a.message_id = ? ORDER BY a.created_at, a.rowid`,
  )
  const delivered = db.prepare(
    'UPDATE attachments SET downloads = downloads + 1, first_downloaded_at = COALESCE(first_downloaded_at, ?) WHERE id = ?',
  )
  const graceMs = () => (opts.settings?.get('consume_grace_min') ?? DEFAULT_GRACE_MIN) * 60_000

  function status(r: AttachmentRow): AttachmentStatus {
    if (r.deleted_reason === 'consumed') return 'consumed'
    if (r.deleted_at !== null) return 'expired'
    const t = now()
    if (r.expires_at <= t) return 'expired'
    if (
      r.on_download === 'consume' &&
      r.first_downloaded_at !== null &&
      r.first_downloaded_at + graceMs() <= t
    )
      return 'consumed'
    if (opts.files && !opts.files.has(r.id)) return 'file_gone'
    return 'available'
  }

  return {
    get: (id) => (byId.get(id) as AttachmentRow | undefined) ?? null,
    forMessage: (messageId) => byMessage.all(messageId) as AttachmentRow[],
    status,
    view: (r) => ({
      id: r.id,
      filename: r.filename,
      mime_type: r.mime_type,
      category: r.category,
      size_bytes: r.size_bytes,
      sha256: r.sha256,
      on_download: r.on_download,
      expires_at: new Date(r.expires_at).toISOString(),
      status: status(r),
    }),
    /** Livraison complète seulement (flux terminé sans erreur, ou bloc inline construit). */
    recordDelivery(id) {
      delivered.run(now(), id)
    },
  }
}

export function newAttachments(
  files: readonly StagedFile[],
  onDownload: OnDownload,
  settings: Settings,
  createdAt: number,
): NewAttachment[] {
  return files.map((f) => ({
    id: f.id,
    filename: f.filename,
    mime_type: f.mime_type,
    category: f.category,
    size_bytes: f.size_bytes,
    sha256: f.sha256,
    on_download: onDownload,
    expires_at: computeExpiresAt(
      { createdAt, category: f.category, sizeBytes: f.size_bytes },
      settings,
    ),
  }))
}
