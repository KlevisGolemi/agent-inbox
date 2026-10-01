import type Database from 'better-sqlite3'
import { log as defaultLog } from '../log.js'
import type { QueueRepo } from '../queue/repo.js'
import type { Settings } from '../settings/index.js'

const HOUR_MS = 3_600_000
const MIN_MS = 60_000

export interface CleanupReport {
  readDeleted: number
  pendingExpired: number
  oauthDeleted: number
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

/** Nettoyage périodique : messages (TTL global + par topic), OAuth expiré/révoqué, sessions admin expirées. */
export function startCleanup(deps: CleanupDeps): { runOnce(): CleanupReport; stop(): void } {
  const { db, repo, settings } = deps
  const log = deps.log ?? defaultLog
  const now = deps.now ?? Date.now
  const setTimer = deps.setTimer ?? setTimeout
  const clearTimer = deps.clearTimer ?? clearTimeout

  const delCodes = db.prepare('DELETE FROM oauth_codes WHERE expires_at < ?')
  const delTokens = db.prepare('DELETE FROM oauth_tokens WHERE expires_at < ? OR revoked = 1')
  const delSessions = db.prepare('DELETE FROM admin_sessions WHERE expires_at < ?')

  function runOnce(): CleanupReport {
    const t = now()
    const { read, pending } = repo.deleteExpired(
      t - settings.get('ttl_hours') * HOUR_MS,
      settings.get('topic_ttl_overrides'),
      t,
    )
    const oauthDeleted = delCodes.run(t).changes + delTokens.run(t).changes
    const sessionsDeleted = delSessions.run(t).changes
    db.pragma('optimize')
    const report = { readDeleted: read, pendingExpired: pending, oauthDeleted, sessionsDeleted }
    if (read + pending + oauthDeleted + sessionsDeleted > 0) {
      log('info', 'Nettoyage effectué', report)
    }
    return report
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
    try {
      runOnce()
    } catch (err) {
      log('error', 'Échec du nettoyage', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
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
