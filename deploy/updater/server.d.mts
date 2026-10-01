import type { Server } from 'node:http'

export interface UpdaterOptions {
  secret: string
  /** Exécute la mise à jour ; rejette en cas d'échec. */
  run: () => Promise<void>
  /** Journal JSON une ligne (défaut : stdout). */
  log?: (level: 'info' | 'error', msg: string, fields?: Record<string, unknown>) => void
}

export function createUpdaterServer(options: UpdaterOptions): Server
export function runCompose(env?: Record<string, string | undefined>): Promise<void>
