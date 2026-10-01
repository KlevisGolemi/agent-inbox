import { fileURLToPath } from 'node:url'
import cookieParser from 'cookie-parser'
import express, { type ErrorRequestHandler, type Express } from 'express'
import type Database from 'better-sqlite3'
import { createAdminRouter } from './admin/routes.js'
import type { ApiKeys } from './auth/apiKeys.js'
import { createBearerMiddleware, mcpResourceMetadataUrl } from './auth/bearer.js'
import { createOAuthRouter } from './auth/oauth/router.js'
import type { SqliteOAuthProvider } from './auth/oauth/provider.js'
import { createAuthPagesRouter } from './auth/pages.js'
import { requireAdminSession, type AdminSessions } from './auth/sessions.js'
import type { Users } from './auth/users.js'
import type { Backups } from './backups/index.js'
import type { Env } from './env.js'
import { log } from './log.js'
import './zod.js'
import { createMcpRouter } from './mcp/server.js'
import { createWaitPool, type WaitPool } from './queue/http.js'
import { createQueueRouter } from './queue/routes.js'
import type { QueueRepo } from './queue/repo.js'
import type { Settings } from './settings/index.js'
import type { VersionService } from './version/index.js'

export interface AppDeps {
  db: Database.Database
  settings: Settings
  repo: QueueRepo
  version: string
  versions: VersionService
  /** Remplaçable en test ; `fetch` global par défaut. */
  updaterFetch?: typeof fetch
  env: Env
  users: Users
  sessions: AdminSessions
  /** Code de setup courant (mutable) ; null une fois utilisé ou si un compte existe. */
  setupCode: { value: string | null }
  apiKeys: ApiKeys
  oauthProvider: SqliteOAuthProvider
  /** Instance unique, partagée avec la planification. */
  backups: Backups
  /** Attentes longues (plafond + signal d'arrêt) ; une instance neuve par défaut. */
  waits?: WaitPool
}

/** Dossier de l'interface (même chemin relatif depuis src/admin et dist/admin). */
const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url))

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

/**
 * Dernier recours : une ligne de log (chemin sans query string, première ligne du message,
 * jamais la pile) et une réponse JSON générique, sans détail interne.
 */
const unhandledErrors: ErrorRequestHandler = (err, req, res, next) => {
  const message = (err instanceof Error ? err.message : String(err)).split('\n')[0]
  log('error', 'Erreur non gérée', { path: req.path, error: message })
  if (res.headersSent) {
    next(err)
    return
  }
  res.status(500).json({ ok: false, error: 'internal_error', message: 'Erreur interne.' })
}

export function createApp(deps: AppDeps): Express {
  const app = express()
  // Nombre de proxys de confiance (TRUST_PROXY) : détermine req.ip, donc le rate limit.
  app.set('trust proxy', deps.env.trustProxy)
  app.disable('x-powered-by')
  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "frame-ancestors 'none'",
    })
    next()
  })
  app.use(cookieParser())
  // L'API d'administration s'authentifie avant de lire le corps (JSON 401 toujours, jamais de redirection).
  app.use('/admin/api', requireAdminSession(deps.sessions, { json: true }))
  app.use(express.json({ limit: '1mb' }))

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, uptime_s: Math.floor(process.uptime()), version: deps.version })
  })
  const waits = deps.waits ?? createWaitPool()
  app.use(createQueueRouter({ repo: deps.repo, settings: deps.settings, waits }))
  app.use(
    createMcpRouter({
      repo: deps.repo,
      settings: deps.settings,
      version: deps.version,
      waits,
      bearer: createBearerMiddleware({
        provider: deps.oauthProvider,
        apiKeys: deps.apiKeys,
        resourceMetadataUrl: mcpResourceMetadataUrl(deps.env),
      }),
    }),
  )
  app.use(
    createOAuthRouter({ provider: deps.oauthProvider, sessions: deps.sessions, env: deps.env }),
  )
  app.use(
    createAuthPagesRouter({
      users: deps.users,
      sessions: deps.sessions,
      setupCode: deps.setupCode,
      env: deps.env,
    }),
  )

  // Interface d'administration : page protégée par la session, ressources publiques (sans secret).
  app.get('/', (_req, res) => {
    res.redirect(302, '/admin')
  })
  app.use('/admin/assets', express.static(PUBLIC_DIR, { index: false, redirect: false }))
  app.get('/admin', requireAdminSession(deps.sessions), (_req, res) => {
    res.set('Cache-Control', 'no-store')
    res.sendFile('index.html', { root: PUBLIC_DIR })
  })
  app.use('/admin/api', createAdminRouter(deps))

  app.use(bodyErrors)
  app.use(unhandledErrors)
  return app
}
