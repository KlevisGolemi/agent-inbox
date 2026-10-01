import { log as defaultLog } from '../log.js'
import type { Backups } from '../backups/index.js'
import type { Settings } from '../settings/index.js'

const HOUR_MS = 3_600_000

export interface BackupJobDeps {
  backups: Backups
  settings: Settings
  log?: typeof defaultLog
  setTimer?: typeof setTimeout
  clearTimer?: typeof clearTimeout
}

/**
 * Sauvegardes planifiées : première exécution après un intervalle (pas au démarrage),
 * intervalle relu après chaque exécution et à chaque changement ; 0 = désactivé.
 */
export function startBackups(deps: BackupJobDeps): { runOnce(): Promise<void>; stop(): void } {
  const { backups, settings } = deps
  const log = deps.log ?? defaultLog
  const setTimer = deps.setTimer ?? setTimeout
  const clearTimer = deps.clearTimer ?? clearTimeout

  /** Exécution sûre : une erreur est loguée, jamais propagée. */
  async function runOnce(): Promise<void> {
    try {
      const b = await backups.run()
      log('info', 'Sauvegarde effectuée', { name: b.name, size: b.size })
    } catch (err) {
      log('error', 'Échec de la sauvegarde', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false

  function schedule(): void {
    if (timer !== undefined) clearTimer(timer)
    timer = undefined
    const hours = settings.get('backup_interval_hours')
    if (stopped || hours === 0) return
    timer = setTimer(() => void tick(), hours * HOUR_MS)
    if (typeof timer === 'object' && 'unref' in timer) timer.unref()
  }

  async function tick(): Promise<void> {
    await runOnce()
    schedule()
  }

  const unsubscribe = settings.onChange((key) => {
    if (key === 'backup_interval_hours') schedule()
  })

  schedule()

  return {
    runOnce,
    stop() {
      stopped = true
      unsubscribe()
      if (timer !== undefined) clearTimer(timer)
    },
  }
}
