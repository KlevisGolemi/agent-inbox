import cookieParser from 'cookie-parser'
import express, { type ErrorRequestHandler, type Express } from 'express'
import type Database from 'better-sqlite3'
import { createAuthPagesRouter } from './auth/pages.js'
import type { AdminSessions } from './auth/sessions.js'
import type { Users } from './auth/users.js'
import type { Env } from './env.js'
import { createQueueRouter } from './queue/routes.js'
import type { QueueRepo } from './queue/repo.js'
import type { Settings } from './settings/index.js'

export interface AppDeps {
  db: Database.Database
  settings: Settings
  repo: QueueRepo
  version: string
  env: Env
  users: Users
  sessions: AdminSessions
  /** Code de setup courant (mutable) ; null une fois utilisé ou si un compte existe. */
  setupCode: { value: string | null }
}

/** Erreurs de lecture du corps : réponses JSON stables (413 trop gros, 400 JSON invalide). */
const bodyErrors: ErrorRequestHandler = (err, _req, res, next) => {
  const type = (err as { type?: string }).type
  if (type === 'entity.too.large') {
    res.status(413).json({ ok: false, error: 'payload_too_large' })
  } else if (type === 'entity.parse.failed') {
    res.status(400).json({ ok: false, error: 'invalid_json' })
  } else {
    next(err)
  }
}

export function createApp(deps: AppDeps): Express {
  const app = express()
  // Traefik est en frontal : on fait confiance à 1 proxy pour req.ip (rate limit).
  app.set('trust proxy', 1)
  app.disable('x-powered-by')
  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "frame-ancestors 'none'",
    })
    next()
  })
  app.use(express.json({ limit: '1mb' }))
  app.use(cookieParser())

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, uptime_s: Math.floor(process.uptime()), version: deps.version })
  })
  app.use(createQueueRouter({ repo: deps.repo, settings: deps.settings }))
  app.use(
    createAuthPagesRouter({
      users: deps.users,
      sessions: deps.sessions,
      setupCode: deps.setupCode,
      env: deps.env,
    }),
  )

  app.use(bodyErrors)
  return app
}
