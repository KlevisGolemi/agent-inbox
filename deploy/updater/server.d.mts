import type { Server } from 'node:http'

export interface UpdaterOptions {
  secret: string
  /** Exécute la mise à jour ; rejette en cas d'échec. `signal` est annulé au délai dépassé. */
  run: (signal: AbortSignal) => Promise<void>
  /** Journal JSON une ligne (défaut : stdout). */
  log?: (level: 'info' | 'error', msg: string, fields?: Record<string, unknown>) => void
  /** Durée maximale d'une mise à jour (défaut : UPDATE_TIMEOUT_MS, 10 min). */
  timeoutMs?: number
}

export const UPDATE_TIMEOUT_MS: number

export function createUpdaterServer(options: UpdaterOptions): Server
export function runCompose(
  env?: Record<string, string | undefined>,
  signal?: AbortSignal,
): Promise<void>
export function dockerEnv(source?: Record<string, string | undefined>): Record<string, string>
