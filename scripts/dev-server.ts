/**
 * Serveur de développement pour l'interface d'administration (npm run dev:ui).
 * Base SQLite sur disque dans .dev/, compte admin@example.com / dev-password-123.
 * Remplacé par src/index.ts pour la production (Task 12).
 */
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { createApp } from '../src/app.js'
import { createApiKeys } from '../src/auth/apiKeys.js'
import { SqliteOAuthProvider } from '../src/auth/oauth/provider.js'
import { createBackups } from '../src/backups/index.js'
import { startBackups } from '../src/jobs/backup.js'
import { createAdminSessions } from '../src/auth/sessions.js'
import { createUsers } from '../src/auth/users.js'
import { openDb } from '../src/db/index.js'
import { migrate } from '../src/db/migrations.js'
import { loadEnv } from '../src/env.js'
import { log } from '../src/log.js'
import { createQueueRepo } from '../src/queue/repo.js'
import { createSettings, seedSettings } from '../src/settings/index.js'
import { createVersionService } from '../src/version/index.js'

// Identifiants de développement : source de vérité du compte créé ci-dessous (jamais affichés).
const ADMIN_EMAIL = 'admin@example.com'
const ADMIN_PASSWORD = 'dev-password-123'

mkdirSync('.dev', { recursive: true })
const env = loadEnv({
  PUBLIC_URL: 'http://localhost:3000',
  NODE_ENV: 'development',
  PORT: '3000',
  DB_PATH: '.dev/queue.db',
})

const db = openDb(env.dbPath)
migrate(db)
const settings = createSettings(db)
seedSettings(settings, db, env.seed, () => randomBytes(32).toString('base64url'))

const users = createUsers(db)
if (users.count() === 0) await users.create(ADMIN_EMAIL, ADMIN_PASSWORD)

const sessions = createAdminSessions(db)
const backupsDir = join(dirname(env.dbPath), 'backups')
const app = createApp({
  db,
  settings,
  repo: createQueueRepo(db, { leaseTimeoutMs: () => settings.get('lease_timeout_sec') * 1000 }),
  version: '2.0.0-dev',
  versions: createVersionService({
    settings,
    fetch,
    current: '2.0.0-dev',
    repo: env.updateRepo,
  }),
  env,
  users,
  sessions,
  setupCode: { value: null },
  apiKeys: createApiKeys(db),
  oauthProvider: new SqliteOAuthProvider({ db, sessions, env }),
  backupsDir,
})

startBackups({ backups: createBackups({ db, dir: backupsDir, settings }), settings })

app.listen(env.port, () => {
  log('info', 'Interface d’administration prête', {
    url: `http://localhost:${env.port}/admin`,
    admin_email: ADMIN_EMAIL,
  })
})
