import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { log as defaultLog } from '../log.js'
import type { LogFn } from './types.js'

const ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export interface FileStore {
  readonly root: string
  readonly tmpDir: string
  init(): void
  newTempId(): string
  tempPath(id: string): string
  path(id: string): string
  has(id: string): boolean
  promote(ids: readonly string[]): void
  unlinkTemp(ids: readonly string[]): number
  unlinkFinal(ids: readonly string[]): number
  usedBytes(): number
  liveCount(): number
  listFinal(): string[]
  listTemp(): { id: string; mtimeMs: number }[]
}

/**
 * Seul propriétaire du disque : temporaires dans `.tmp/`, fichiers définitifs nommés par uuid.
 * Aucune méthode ne reçoit de nom d'origine ; un identifiant invalide lève une erreur.
 */
export function createFileStore(deps: { db: Database.Database; root: string; log?: LogFn }): FileStore {
  const { db, root } = deps
  const log = deps.log ?? defaultLog
  const tmpDir = join(root, '.tmp')
  const live = db.prepare(
    'SELECT COALESCE(SUM(size_bytes), 0) AS bytes, COUNT(*) AS n FROM attachments WHERE deleted_at IS NULL',
  )
  const checked = (id: string): string => {
    if (!ID_REGEX.test(id)) throw new Error('Identifiant de fichier invalide')
    return id
  }
  const removeAll = (dir: string, ids: readonly string[]): number => {
    let removed = 0
    let failed = 0
    for (const id of ids) {
      try {
        unlinkSync(join(dir, checked(id)))
        removed++
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') failed++
      }
    }
    // Jamais de nom ni de chemin dans les logs : un compteur suffit (le nettoyage reprendra).
    if (failed > 0) log('warn', 'Effacement de fichiers en échec', { count: failed })
    return removed
  }

  return {
    root,
    tmpDir,
    init() {
      mkdirSync(tmpDir, { recursive: true, mode: 0o700 })
      if (process.platform !== 'win32') {
        chmodSync(root, 0o700)
        chmodSync(tmpDir, 0o700)
      }
    },
    newTempId: () => randomUUID(),
    tempPath: (id) => join(tmpDir, checked(id)),
    path: (id) => join(root, checked(id)),
    has: (id) => ID_REGEX.test(id) && existsSync(join(root, id)),
    promote(ids) {
      const valid = ids.map(checked)
      // Pré-vérification : un temporaire absent ne doit pas déplacer les précédents.
      if (valid.some((id) => !existsSync(join(tmpDir, id)))) {
        throw new Error('Temporaire de fichier introuvable')
      }
      const done: string[] = []
      try {
        for (const id of valid) {
          renameSync(join(tmpDir, id), join(root, id))
          done.push(id)
        }
      } catch (err) {
        for (const id of done) {
          try {
            renameSync(join(root, id), join(tmpDir, id))
          } catch {
            // Orphelin : repris par le nettoyage.
          }
        }
        throw err
      }
    },
    unlinkTemp: (ids) => removeAll(tmpDir, ids),
    unlinkFinal: (ids) => removeAll(root, ids),
    usedBytes: () => (live.get() as { bytes: number }).bytes,
    liveCount: () => (live.get() as { n: number }).n,
    listFinal: () => readdirSync(root).filter((name) => ID_REGEX.test(name)),
    listTemp: () =>
      readdirSync(tmpDir)
        .filter((name) => ID_REGEX.test(name))
        .flatMap((id) => {
          try {
            return [{ id, mtimeMs: statSync(join(tmpDir, id)).mtimeMs }]
          } catch (err) {
            // Temporaire supprimé entre readdir et stat : rien à nettoyer.
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
            throw err
          }
        }),
  }
}
