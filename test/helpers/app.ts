import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import type { Response } from 'supertest'
import { createApp, type AppDeps } from '../../src/app.js'
import { createBackups } from '../../src/backups/index.js'
import { createAttachmentsRepo } from '../../src/files/attachments.js'
import { createFileStore } from '../../src/files/store.js'
import { createUploadManager } from '../../src/files/uploads.js'
import { createApiKeys } from '../../src/auth/apiKeys.js'
import { SqliteOAuthProvider } from '../../src/auth/oauth/provider.js'
import { createAdminSessions } from '../../src/auth/sessions.js'
import { createUsers } from '../../src/auth/users.js'
import { openDb } from '../../src/db/index.js'
import { migrate } from '../../src/db/migrations.js'
import type { Env } from '../../src/env.js'
import { createQueueRepo } from '../../src/queue/repo.js'
import { createSettings, rotateFileSigningSecret, seedSettings } from '../../src/settings/index.js'
import { createVersionService } from '../../src/version/index.js'

/** Env de test : https, NODE_ENV=test (cookies Secure). */
export function testEnv(over: Partial<Env> = {}): Env {
  return {
    publicUrl: new URL('https://queue.example.test/'),
    port: 3000,
    dbPath: ':memory:',
    nodeEnv: 'test',
    trustProxy: 1,
    updateRepo: 'KlevisGolemi/agent-inbox',
    seed: {},
    ...over,
  }
}

/** Base en mémoire migrée (journal de migration silencieux). */
export function testDb(): Database.Database {
  const db = openDb(':memory:')
  migrate(db, () => {})
  return db
}

/**
 * Dépendances complètes de l'application avec des valeurs par défaut ;
 * chaque champ peut être remplacé. Les réglages sont amorcés si la base est neuve.
 */
export function makeAppDeps(over: Partial<AppDeps> = {}): AppDeps {
  const db = over.db ?? testDb()
  const settings = over.settings ?? createSettings(db)
  if (!over.settings) seedSettings(settings, db, {}, () => 'g'.repeat(64))
  const env = over.env ?? testEnv()
  const sessions = over.sessions ?? createAdminSessions(db)
  const files =
    over.files ??
    createFileStore({ db, root: mkdtempSync(join(tmpdir(), 'inbox-files-')), log: () => {} })
  if (!over.files) files.init()
  const uploads =
    over.uploads ??
    createUploadManager({
      store: files,
      settings,
      statfs: () => ({ bavail: 1e12, bsize: 1 }),
      log: () => {},
    })
  return {
    db,
    settings,
    repo: over.repo ?? createQueueRepo(db, { files, settings }),
    files,
    uploads,
    attachments: over.attachments ?? createAttachmentsRepo(db, { files, settings }),
    version: over.version ?? '0.0.0-test',
    versions:
      over.versions ??
      createVersionService({
        settings,
        fetch: async () => Response.json({ tag_name: 'v0.0.0-test', body: '', html_url: '' }),
        current: over.version ?? '0.0.0-test',
        repo: env.updateRepo,
      }),
    updaterFetch: over.updaterFetch,
    env,
    users: over.users ?? createUsers(db),
    sessions,
    setupCode: over.setupCode ?? { value: null },
    apiKeys: over.apiKeys ?? createApiKeys(db),
    oauthProvider: over.oauthProvider ?? new SqliteOAuthProvider({ db, sessions, env }),
    backups:
      over.backups ??
      createBackups({
        db,
        dir: mkdtempSync(join(tmpdir(), 'cq-backups-')),
        settings,
        onRestore: () => rotateFileSigningSecret(settings),
      }),
    waits: over.waits,
  }
}

export function makeTestApp(over: Partial<AppDeps> = {}) {
  const deps = makeAppDeps(over)
  return { ...deps, app: createApp(deps) }
}

/** Valeur d'un cookie posé par une réponse (en-tête Set-Cookie), ou undefined. */
export function getSetCookie(res: Response, name: string): string | undefined {
  return setCookieLines(res, name)[0]
    ?.split(';')[0]
    ?.slice(name.length + 1)
}

/** Lignes Set-Cookie complètes pour un cookie donné. */
export function setCookieLines(res: Response, name: string): string[] {
  const raw = res.headers['set-cookie'] as unknown
  const lines = Array.isArray(raw) ? (raw as string[]) : typeof raw === 'string' ? [raw] : []
  return lines.filter((l) => l.startsWith(`${name}=`))
}
