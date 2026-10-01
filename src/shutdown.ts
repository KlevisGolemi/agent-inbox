import type { LogLevel } from './log.js'

/** Délai avant fermeture forcée des connexions restantes (réponses « vides » déjà écrites). */
export const SHUTDOWN_GRACE_MS = 1_000
/** Au-delà, sortie forcée (code 1) ; inférieur au `stop_grace_period` (20 s) de Docker. */
export const SHUTDOWN_TIMEOUT_MS = 15_000

export interface ShutdownDeps {
  server: {
    close(cb?: (err?: Error) => void): unknown
    closeIdleConnections(): void
    closeAllConnections(): void
  }
  runtime: { shutdown: AbortController; db: { close(): unknown } }
  jobs: { stop(): void }
  exit: (code: number) => void
  log: (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void
}

/**
 * Arrêt propre (SIGTERM / SIGINT) : les attentes longues se résolvent aussitôt en « vide »,
 * les tâches périodiques s'arrêtent, le serveur cesse d'accepter des connexions, puis la base
 * est fermée. Les connexions encore ouvertes sont coupées après `SHUTDOWN_GRACE_MS` ; sortie
 * forcée après `SHUTDOWN_TIMEOUT_MS`. Idempotent.
 */
export function createShutdown(deps: ShutdownDeps): (signal: string) => void {
  const { server, runtime, jobs, exit, log } = deps
  let stopping = false
  return (signal) => {
    if (stopping) return
    stopping = true
    log('info', 'Arrêt en cours', { signal })
    runtime.shutdown.abort()
    jobs.stop()
    server.close(() => {
      runtime.db.close()
      log('info', 'Arrêt terminé')
      exit(0)
    })
    server.closeIdleConnections()
    setTimeout(() => server.closeAllConnections(), SHUTDOWN_GRACE_MS).unref()
    setTimeout(() => {
      log('warn', 'Arrêt forcé après délai')
      exit(1)
    }, SHUTDOWN_TIMEOUT_MS).unref()
  }
}
