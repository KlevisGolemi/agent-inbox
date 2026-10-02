import type Database from 'better-sqlite3'
import type { FileStore } from '../files/store.js'
import { sweepFiles, type FileSweepReport } from '../files/sweep.js'
import type { UploadManager } from '../files/uploads.js'
import { log as defaultLog } from '../log.js'
import type { QueueRepo } from '../queue/repo.js'
import type { Settings } from '../settings/index.js'

const HOUR_MS = 3_600_000
const MIN_MS = 60_000
/** Un client OAuth inactif (aucun jeton valide ni code en cours) depuis sa création au-delà de ce délai est purgé. */
export const OAUTH_CLIENT_IDLE_MS = 30 * 24 * HOUR_MS
/** Un lien de dépôt expiré ou révoqué depuis plus de ce délai est purgé (avec événements et tags). */
export const DROP_RETENTION_MS = 30 * 24 * HOUR_MS

const EMPTY_SWEEP: FileSweepReport = {
  filesExpired: 0,
  filesConsumed: 0,
  orphansDeleted: 0,
  tempsDeleted: 0,
}

export interface CleanupReport extends FileSweepReport {
  readDeleted: number
  pendingExpired: number
  oauthDeleted: number
  clientsDeleted: number
  sessionsDeleted: number
  dropsDeleted: number
}

export interface CleanupDeps {
  db: Database.Database
  repo: QueueRepo
  settings: Settings
  files?: FileStore
  uploads?: UploadManager
  log?: typeof defaultLog
  now?: () => number
  setTimer?: typeof setTimeout
  clearTimer?: typeof clearTimeout
}

/**
 * Nettoyage périodique : messages (TTL global + par topic), codes et jetons OAuth expirés,
 * clients OAuth inactifs, sessions admin expirées, liens de dépôt expirés ou révoqués depuis 30 jours. Les jetons révoqués sont gardés jusqu'à leur
 * expiration : un refresh révoqué rejoué doit encore déclencher la détection de réutilisation.
 */
export function startCleanup(deps: CleanupDeps): { runOnce(): CleanupReport; stop(): void } {
  const { db, repo, settings } = deps
  const log = deps.log ?? defaultLog
  const now = deps.now ?? Date.now
  const setTimer = deps.setTimer ?? setTimeout
  const clearTimer = deps.clearTimer ?? clearTimeout

  const delCodes = db.prepare('DELETE FROM oauth_codes WHERE expires_at <= ?')
  const delTokens = db.prepare('DELETE FROM oauth_tokens WHERE expires_at <= ?')
  // Client inactif : aucun jeton valide ni code d'autorisation en cours (réautorisation pas encore
  // échangée). Ses codes et jetons partent avec lui (ON DELETE CASCADE).
  const delClients = db.prepare(
    `DELETE FROM oauth_clients
      WHERE created_at <= :cutoff
        AND NOT EXISTS (SELECT 1 FROM oauth_tokens t
                         WHERE t.client_id = oauth_clients.client_id
                           AND t.revoked = 0 AND t.expires_at > :now)
        AND NOT EXISTS (SELECT 1 FROM oauth_codes c
                         WHERE c.client_id = oauth_clients.client_id
                           AND c.expires_at > :now)`,
  )
  const delSessions = db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?')
  // drop_events et drop_tags partent avec le lien (ON DELETE CASCADE) ; messages.drop_id reste.
  const delDrops = db.prepare(
    'DELETE FROM drops WHERE expires_at <= :cutoff OR (revoked_at IS NOT NULL AND revoked_at <= :cutoff)',
  )

  function execute(): CleanupReport {
    const t = now()
    // Pièces avant messages : un message à pièce vivante n'est jamais supprimé par le TTL.
    const sweep = deps.files
      ? sweepFiles({ db, files: deps.files, settings, uploads: deps.uploads, now: t })
      : EMPTY_SWEEP
    const { read, pending } = repo.deleteExpired(
      t - settings.get('ttl_hours') * HOUR_MS,
      settings.get('topic_ttl_overrides'),
      t,
    )
    const oauthDeleted = delCodes.run(t).changes + delTokens.run(t).changes
    const clientsDeleted = delClients.run({ cutoff: t - OAUTH_CLIENT_IDLE_MS, now: t }).changes
    const sessionsDeleted = delSessions.run(t).changes
    const dropsDeleted = delDrops.run({ cutoff: t - DROP_RETENTION_MS }).changes
    db.pragma('optimize')
    const report = {
      readDeleted: read,
      pendingExpired: pending,
      oauthDeleted,
      clientsDeleted,
      sessionsDeleted,
      dropsDeleted,
      ...sweep,
    }
    const sweepTotal =
      sweep.filesExpired + sweep.filesConsumed + sweep.orphansDeleted + sweep.tempsDeleted
    const total = read + pending + oauthDeleted + clientsDeleted + sessionsDeleted + dropsDeleted
    if (total + sweepTotal > 0) {
      log('info', 'Nettoyage effectué', report)
    }
    return report
  }

  /** Exécution sûre : une erreur est loguée, jamais propagée. */
  function runOnce(): CleanupReport {
    try {
      return execute()
    } catch (err) {
      log('error', 'Échec du nettoyage', {
        error: err instanceof Error ? err.message : String(err),
      })
      return {
        readDeleted: 0,
        pendingExpired: 0,
        oauthDeleted: 0,
        clientsDeleted: 0,
        sessionsDeleted: 0,
        dropsDeleted: 0,
        ...EMPTY_SWEEP,
      }
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false

  function schedule(): void {
    if (stopped) return
    if (timer !== undefined) clearTimer(timer)
    timer = setTimer(tick, settings.get('cleanup_interval_min') * MIN_MS)
    if (typeof timer === 'object' && 'unref' in timer) timer.unref()
  }

  function tick(): void {
    runOnce()
    schedule()
  }

  const unsubscribe = settings.onChange((key) => {
    if (key === 'cleanup_interval_min') schedule()
  })

  tick()

  return {
    runOnce,
    stop() {
      stopped = true
      unsubscribe()
      if (timer !== undefined) clearTimer(timer)
    },
  }
}
