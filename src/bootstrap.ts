import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type Database from 'better-sqlite3'
import { createApp } from './app.js'
import { createApiKeys } from './auth/apiKeys.js'
import { SqliteOAuthProvider } from './auth/oauth/provider.js'
import { createAdminSessions } from './auth/sessions.js'
import { ensureAdmin } from './auth/setup.js'
import { createUsers, type Users } from './auth/users.js'
import { createBackups, type Backups } from './backups/index.js'
import { openDb } from './db/index.js'
import { migrate } from './db/migrations.js'
import type { Env } from './env.js'
import { startBackups } from './jobs/backup.js'
import { createAttachmentsRepo } from './files/attachments.js'
import { createFileStore, type FileStore } from './files/store.js'
import { createUploadManager, type UploadManager } from './files/uploads.js'
import { startCleanup } from './jobs/cleanup.js'
import { log } from './log.js'
import { createWaitPool, type WaitPool } from './queue/http.js'
import { createQueueRepo } from './queue/repo.js'
import {
  createSettings,
  generateSecret,
  rotateFileSigningSecret,
  seedSettings,
  type Settings,
} from './settings/index.js'
import { createVersionService } from './version/index.js'

/** Version courante : package.json, au même chemin relatif depuis src/ et dist/. */
const { version: VERSION } = createRequire(import.meta.url)('../package.json') as {
  version: string
}

export interface Runtime {
  app: ReturnType<typeof createApp>
  db: Database.Database
  settings: Settings
  users: Users
  backups: Backups
  files: FileStore
  uploads: UploadManager
  setupCode: { value: string | null }
  /** Arrêt : `shutdown.abort()` résout aussitôt toutes les attentes longues (HTTP et MCP). */
  shutdown: AbortController
  /** Attentes longues en cours (plafond `MAX_WAITERS`). */
  waits: WaitPool
  /** Lance les tâches périodiques (nettoyage, sauvegardes) ; stop() les arrête. */
  start(): { stop(): void }
}

/** Assemble toutes les dépendances de l'application (production, développement et tests). */
export async function buildRuntime(env: Env): Promise<Runtime> {
  const db = openDb(env.dbPath)
  migrate(db)
  const settings = createSettings(db)
  seedSettings(settings, db, env.seed, generateSecret)

  const users = createUsers(db)
  const setupCode = { value: (await ensureAdmin({ users, env, log })).setupCode }

  const sessions = createAdminSessions(db)
  const files = createFileStore({ db, root: join(dirname(env.dbPath), 'files') })
  files.init()
  const uploads = createUploadManager({ store: files, settings })
  const repo = createQueueRepo(db, {
    leaseTimeoutMs: () => settings.get('lease_timeout_sec') * 1000,
    files,
    settings,
  })
  const attachments = createAttachmentsRepo(db, { files, settings })
  const backups = createBackups({
    db,
    dir: join(dirname(env.dbPath), 'backups'),
    settings,
    onRestore: () => rotateFileSigningSecret(settings),
  })
  const shutdown = new AbortController()
  const waits = createWaitPool({ signal: shutdown.signal })
  const app = createApp({
    db,
    settings,
    repo,
    files,
    uploads,
    attachments,
    version: VERSION,
    versions: createVersionService({ settings, fetch, current: VERSION, repo: env.updateRepo }),
    env,
    users,
    sessions,
    setupCode,
    apiKeys: createApiKeys(db),
    oauthProvider: new SqliteOAuthProvider({ db, sessions, env }),
    backups,
    waits,
  })

  return {
    app,
    db,
    settings,
    users,
    backups,
    files,
    uploads,
    setupCode,
    shutdown,
    waits,
    start() {
      const cleanup = startCleanup({ db, repo, settings, files, uploads })
      const backupJob = startBackups({ backups, settings })
      return {
        stop() {
          cleanup.stop()
          backupJob.stop()
        },
      }
    },
  }
}
