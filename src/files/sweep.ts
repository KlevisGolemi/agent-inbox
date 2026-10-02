import type Database from 'better-sqlite3'
import type { Settings } from '../settings/index.js'
import type { FileStore } from './store.js'
import type { UploadManager } from './uploads.js'

export const TEMP_MAX_AGE_MS = 3_600_000

export interface FileSweepReport {
  filesExpired: number
  filesConsumed: number
  orphansDeleted: number
  tempsDeleted: number
}

/**
 * Marque (`deleted_at`) les pièces expirées et consommées dans une transaction, efface leurs fichiers
 * après le commit, puis reprend les orphelins (fichier sans ligne vivante) et les temporaires de plus
 * d'une heure qui n'appartiennent à aucun upload en cours.
 */
export function sweepFiles(deps: {
  db: Database.Database
  files: FileStore
  settings: Settings
  uploads?: UploadManager
  now: number
}): FileSweepReport {
  const { db, files, settings, now } = deps
  const grace = settings.get('consume_grace_min') * 60_000
  const { expired, consumed } = db.transaction(() => ({
    expired: db
      .prepare(
        `UPDATE attachments SET deleted_at = :now, deleted_reason = 'expired'
          WHERE deleted_at IS NULL AND expires_at <= :now RETURNING id`,
      )
      .all({ now }) as { id: string }[],
    consumed: db
      .prepare(
        `UPDATE attachments SET deleted_at = :now, deleted_reason = 'consumed'
          WHERE deleted_at IS NULL AND on_download = 'consume'
            AND first_downloaded_at IS NOT NULL AND first_downloaded_at + :grace <= :now RETURNING id`,
      )
      .all({ now, grace }) as { id: string }[],
  }))()
  files.unlinkFinal([...expired, ...consumed].map((r) => r.id))

  const live = new Set(
    (
      db.prepare('SELECT id FROM attachments WHERE deleted_at IS NULL').all() as { id: string }[]
    ).map((r) => r.id),
  )
  const orphansDeleted = files.unlinkFinal(files.listFinal().filter((id) => !live.has(id)))
  const active = deps.uploads?.activeTempIds() ?? new Set<string>()
  const tempsDeleted = files.unlinkTemp(
    files
      .listTemp()
      .filter((t) => now - t.mtimeMs > TEMP_MAX_AGE_MS && !active.has(t.id))
      .map((t) => t.id),
  )
  return {
    filesExpired: expired.length,
    filesConsumed: consumed.length,
    orphansDeleted,
    tempsDeleted,
  }
}
