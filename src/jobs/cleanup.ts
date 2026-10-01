import type Database from 'better-sqlite3'
import { log as defaultLog } from '../log.js'
import type { QueueRepo } from '../queue/repo.js'
import type { Settings } from '../settings/index.js'

const HOUR_MS = 3_600_000
const MIN_MS = 60_000
/** Un client OAuth inactif (aucun jeton valide) depuis sa création au-delà de ce délai est purgé. */
export const OAUTH_CLIENT_IDLE_MS = 30 * 24 * HOUR_MS

export interface CleanupReport {
  readDeleted: number
  pendingExpired: number
  oauthDeleted: number
  clientsDeleted: number
  sessionsDeleted: number
}

export interface CleanupDeps {
  db: Database.Database
  repo: QueueRepo
  settings: Settings
  log?: typeof defaultLog
  now?: () => number
  setTimer?: typeof setTimeout
  clearTimer?: typeof clearTimeout
}

/**
 * Nettoyage périodique : messages (TTL global + par topic), codes et jetons OAuth expirés,
 * clients OAuth inactifs, sessions admin expirées. Les jetons révoqués sont gardés jusqu'à leur
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
  // Codes et jetons du client partent avec lui (ON DELETE CASCADE).
  const delClients = db.prepare(
    `DELETE FROM oauth_clients
      WHERE created_at <= :cutoff
        AND NOT EXISTS (SELECT 1 FROM oauth_tokens t
                         WHERE t.client_id = oauth_clients.client_id
                           AND t.revoked = 0 AND t.expires_at > :now)`,
  )
  const delSessions = db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?')

  function execute(): CleanupReport {
    const t = now()
    const { read, pending } = repo.deleteExpired(
      t - settings.get('ttl_hours') * HOUR_MS,
      settings.get('topic_ttl_overrides'),
      t,
    )
    const oauthDeleted = delCodes.run(t).changes + delTokens.run(t).changes
    const clientsDeleted = delClients.run({ cutoff: t - OAUTH_CLIENT_IDLE_MS, now: t }).changes
    const sessionsDeleted = delSessions.run(t).changes
    db.pragma('optimize')
    const report = {
      readDeleted: read,
      pendingExpired: pending,
      oauthDeleted,
      clientsDeleted,
      sessionsDeleted,
    }
    if (read + pending + oauthDeleted + clientsDeleted + sessionsDeleted > 0) {
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
