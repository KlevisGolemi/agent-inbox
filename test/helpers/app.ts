import type Database from 'better-sqlite3'
import type { Response } from 'supertest'
import { createApp, type AppDeps } from '../../src/app.js'
import { createAdminSessions } from '../../src/auth/sessions.js'
import { createUsers } from '../../src/auth/users.js'
import { openDb } from '../../src/db/index.js'
import { migrate } from '../../src/db/migrations.js'
import type { Env } from '../../src/env.js'
import { createQueueRepo } from '../../src/queue/repo.js'
import { createSettings, seedSettings } from '../../src/settings/index.js'

/** Env de test : https, NODE_ENV=test (cookies Secure). */
export function testEnv(over: Partial<Env> = {}): Env {
  return {
    publicUrl: new URL('https://queue.example.test/'),
    port: 3000,
    dbPath: ':memory:',
    nodeEnv: 'test',
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
  return {
    db,
    settings,
    repo: over.repo ?? createQueueRepo(db),
    version: over.version ?? '0.0.0-test',
    env: over.env ?? testEnv(),
    users: over.users ?? createUsers(db),
    sessions: over.sessions ?? createAdminSessions(db),
    setupCode: over.setupCode ?? { value: null },
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
