import { randomBytes } from 'node:crypto'
import { Router, type NextFunction, type Request, type Response } from 'express'
import type Database from 'better-sqlite3'
import { BackupError, BACKUP_NAME_REGEX, type Backups } from '../backups/index.js'
import type { ApiKeys } from '../auth/apiKeys.js'
import { issueCsrfToken, requireCsrfJson } from '../auth/csrf.js'
import { MIN_PASSWORD_LENGTH, PASSWORD_TOO_SHORT } from '../auth/password.js'
import { SESSION_COOKIE, type AdminSessions } from '../auth/sessions.js'
import type { User, Users } from '../auth/users.js'
import type { Env } from '../env.js'
import { log } from '../log.js'
import { itemView, queryString } from '../queue/http.js'
import type { QueueRepo } from '../queue/repo.js'
import { CORRELATION_ID_REGEX, TOPIC_REGEX } from '../queue/validation.js'
import { SETTING_KEYS, SettingValidationError, type Settings } from '../settings/index.js'
import type { VersionService } from '../version/index.js'

export interface AdminDeps {
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
  apiKeys: ApiKeys
  backups: Backups
}

const MASK = '••••'
const MAX_LIMIT = 500
const UPDATER_TIMEOUT_MS = 10_000
const UPDATE_COMMAND = './update.sh'

/** Réponse d'erreur uniforme de l'API d'administration. */
function fail(res: Response, status: number, error: string, message: string, key?: string): void {
  res.status(status).json({ ok: false, error, message, ...(key ? { key } : {}) })
}

/** Réglages pour l'interface : le secret du webhook est masqué (4 derniers caractères). */
function maskedSettings(settings: Settings) {
  const all = settings.all()
  return { ...all, webhook_secret: MASK + all.webhook_secret.slice(-4) }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Entier borné issu d'un paramètre de requête ; `fallback` si absent, null si invalide. */
function intParam(req: Request, name: string, fallback: number, min: number, max: number) {
  const raw = queryString(req, name)
  if (raw === undefined) return fallback
  if (!/^\d{1,9}$/.test(raw)) return null
  const n = Number(raw)
  return n >= min && n <= max ? n : null
}

export function createAdminRouter(deps: AdminDeps): Router {
  const { db, settings, repo, env, users, sessions, apiKeys } = deps
  const router = Router()
  const { backups } = deps

  // Session vérifiée en amont par app.ts (avant la lecture du corps) : res.locals.user est posé.
  // Réponses sensibles (secret, clés, jeton CSRF) : jamais mises en cache.
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store')
    next()
  })
  router.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'GET' || req.method === 'HEAD') next()
    else requireCsrfJson(req, res, next)
  })

  const publicBase = env.publicUrl.href

  router.get('/overview', (req, res) => {
    res.json({
      ok: true,
      version: deps.version,
      publicUrl: publicBase,
      mcpUrl: `${publicBase}mcp`,
      webhookUrl: `${publicBase}webhook`,
      uptime_s: Math.floor(process.uptime()),
      stats: repo.stats(),
      settings: maskedSettings(settings),
      user: { email: (res.locals.user as User).email },
      csrfToken: issueCsrfToken(req, res, env),
    })
  })

  // ── Réglages ──────────────────────────────────────────────────────
  router.patch('/settings', (req, res) => {
    const body: unknown = req.body
    if (!isPlainObject(body)) {
      fail(res, 400, 'invalid_body', 'Le corps doit être un objet JSON.')
      return
    }
    const unknown = Object.keys(body).find((k) => !(SETTING_KEYS as string[]).includes(k))
    if (unknown !== undefined) {
      fail(res, 400, 'unknown_setting', `Réglage inconnu : « ${unknown} ».`, unknown)
      return
    }
    try {
      settings.update(body)
    } catch (err) {
      if (err instanceof SettingValidationError) {
        fail(res, 400, 'invalid_setting', err.message, err.key)
        return
      }
      throw err
    }
    log('info', 'Réglages modifiés', { keys: Object.keys(body) })
    res.json({ ok: true, settings: maskedSettings(settings) })
  })

  router.get('/settings/webhook-secret', (_req, res) => {
    res.json({ ok: true, secret: settings.get('webhook_secret') })
  })

  router.post('/settings/webhook-secret/rotate', (_req, res) => {
    const secret = randomBytes(32).toString('base64url')
    settings.set('webhook_secret', secret)
    log('info', 'Secret du webhook renouvelé')
    res.json({ ok: true, secret })
  })

  // ── File ──────────────────────────────────────────────────────────
  router.get('/messages', (req, res) => {
    const cid = queryString(req, 'correlation_id')
    if (cid !== undefined) {
      const item = CORRELATION_ID_REGEX.test(cid) ? repo.findByCorrelation(cid) : null
      res.json({
        ok: true,
        items: item ? [itemView(item)] : [],
        total: item ? 1 : 0,
        limit: 1,
        offset: 0,
      })
      return
    }
    const limit = intParam(req, 'limit', 50, 1, MAX_LIMIT)
    const offset = intParam(req, 'offset', 0, 0, 1_000_000_000)
    if (limit === null || offset === null) {
      fail(res, 400, 'invalid_pagination', `limit (1–${MAX_LIMIT}) ou offset invalide.`)
      return
    }
    const topic = queryString(req, 'topic')
    if (topic !== undefined && !TOPIC_REGEX.test(topic)) {
      fail(res, 400, 'invalid_topic', 'Topic invalide (^[A-Za-z0-9_-]{1,128}$).', 'topic')
      return
    }
    res.json({
      ok: true,
      items: repo.peek(limit, offset, { topic }).map(itemView),
      total: repo.stats({ topic }).total,
      limit,
      offset,
    })
  })

  router.post('/messages', (req, res) => {
    const body: unknown = req.body
    if (!isPlainObject(body) || !('payload' in body)) {
      fail(res, 400, 'invalid_body', 'Le champ « payload » est obligatoire.')
      return
    }
    const topic = body.topic === undefined || body.topic === '' ? 'default' : body.topic
    if (typeof topic !== 'string' || !TOPIC_REGEX.test(topic)) {
      fail(res, 400, 'invalid_topic', 'Topic invalide (^[A-Za-z0-9_-]{1,128}$).', 'topic')
      return
    }
    const cid =
      body.correlation_id === undefined || body.correlation_id === '' ? null : body.correlation_id
    if (cid !== null && (typeof cid !== 'string' || !CORRELATION_ID_REGEX.test(cid))) {
      fail(
        res,
        400,
        'invalid_correlation_id',
        'Correlation ID invalide (^[A-Za-z0-9_-]{1,128}$).',
        'correlation_id',
      )
      return
    }
    const result = repo.enqueue({
      payload: body.payload,
      source: 'admin',
      correlationId: cid,
      topic,
    })
    if (!result.ok) {
      fail(res, 409, 'duplicate_correlation_id', 'Ce Correlation ID existe déjà.', 'correlation_id')
      return
    }
    res.status(201).json({ ok: true, id: result.id, pending: result.pending })
  })

  router.delete('/messages/:id', (req, res) => {
    if (repo.deleteById(String(req.params.id))) res.json({ ok: true })
    else fail(res, 404, 'not_found', 'Message introuvable.')
  })

  router.delete('/messages', (req, res) => {
    const body: unknown = req.body
    if (!isPlainObject(body) || body.confirm !== true) {
      fail(res, 400, 'confirmation_required', 'Confirmation requise : { "confirm": true }.')
      return
    }
    const deleted = repo.clear()
    log('info', 'File vidée depuis l’administration', { deleted })
    res.json({ ok: true, deleted })
  })

  // ── Clés API ──────────────────────────────────────────────────────
  router.get('/api-keys', (_req, res) => {
    res.json({ ok: true, keys: apiKeys.list() })
  })

  router.post('/api-keys', (req, res) => {
    const name: unknown = isPlainObject(req.body) ? req.body.name : undefined
    if (typeof name !== 'string') {
      fail(res, 400, 'invalid_name', 'Le nom de la clé est obligatoire.', 'name')
      return
    }
    try {
      const created = apiKeys.create(name)
      log('info', 'Clé API créée', { id: created.id })
      res.status(201).json({ ok: true, ...created })
    } catch (err) {
      fail(res, 400, 'invalid_name', err instanceof Error ? err.message : 'Nom invalide.', 'name')
    }
  })

  router.delete('/api-keys/:id', (req, res) => {
    const raw = String(req.params.id)
    if (!/^\d{1,15}$/.test(raw)) {
      fail(res, 400, 'invalid_id', 'Identifiant invalide.')
      return
    }
    if (apiKeys.revoke(Number(raw))) {
      log('info', 'Clé API révoquée', { id: Number(raw) })
      res.json({ ok: true })
    } else {
      fail(res, 404, 'not_found', 'Clé introuvable ou déjà révoquée.')
    }
  })

  // ── Clients OAuth ─────────────────────────────────────────────────
  const selectClients = db.prepare(
    `SELECT c.client_id, c.metadata, c.created_at,
            (SELECT COUNT(*) FROM oauth_tokens t
              WHERE t.client_id = c.client_id AND t.revoked = 0 AND t.expires_at > ?) AS active_tokens
       FROM oauth_clients c ORDER BY c.created_at DESC`,
  )
  // Les codes et jetons du client partent avec lui (ON DELETE CASCADE).
  const deleteClient = db.prepare('DELETE FROM oauth_clients WHERE client_id = ?')

  router.get('/oauth-clients', (_req, res) => {
    const rows = selectClients.all(Date.now()) as {
      client_id: string
      metadata: string
      created_at: number
      active_tokens: number
    }[]
    const clients = rows.map((r) => {
      const meta = JSON.parse(r.metadata) as { client_name?: string; redirect_uris?: string[] }
      return {
        client_id: r.client_id,
        client_name: meta.client_name ?? null,
        redirect_uris: meta.redirect_uris ?? [],
        created_at: new Date(r.created_at).toISOString(),
        active_tokens: r.active_tokens,
      }
    })
    res.json({ ok: true, clients })
  })

  router.delete('/oauth-clients/:id', (req, res) => {
    const id = String(req.params.id)
    if (id.length <= 128 && deleteClient.run(id).changes > 0) {
      log('info', 'Client OAuth supprimé', { client_id: id })
      res.json({ ok: true })
    } else {
      fail(res, 404, 'not_found', 'Client introuvable.')
    }
  })

  // ── Version et mise à jour ────────────────────────────────────────
  router.get('/version', async (_req, res) => {
    res.json({ ok: true, ...(await deps.versions.check()), updater: env.updater !== undefined })
  })

  router.post('/update', async (_req, res) => {
    const updater = env.updater
    if (!updater) {
      res.status(409).json({
        ok: false,
        error: 'no_updater',
        message: 'La mise à jour en un clic n’est pas activée. Lancez la commande sur le serveur.',
        command: UPDATE_COMMAND,
      })
      return
    }
    let status: number
    try {
      const upstream = await (deps.updaterFetch ?? fetch)(new URL('/update', updater.url), {
        method: 'POST',
        headers: { 'x-updater-secret': updater.secret },
        signal: AbortSignal.timeout(UPDATER_TIMEOUT_MS),
      })
      status = upstream.status
    } catch (err) {
      log('warn', 'Updater injoignable', {
        reason: err instanceof Error ? err.message : 'inconnue',
      })
      fail(res, 502, 'updater_unreachable', 'Le service de mise à jour ne répond pas.')
      return
    }
    if (status === 409) {
      fail(res, 409, 'update_running', 'Une mise à jour est déjà en cours.')
      return
    }
    if (status === 401) {
      log('error', 'Updater : secret refusé (UPDATER_SECRET différent des deux côtés ?)')
      fail(
        res,
        502,
        'updater_misconfigured',
        'Le service de mise à jour refuse le secret configuré.',
      )
      return
    }
    if (status !== 202) {
      log('warn', 'Updater : réponse inattendue', { status })
      fail(
        res,
        502,
        'updater_unreachable',
        'Le service de mise à jour a répondu de façon inattendue.',
      )
      return
    }
    log('info', 'Mise à jour demandée depuis l’administration')
    res.status(202).json({ ok: true, started: true })
  })

  // ── Sauvegardes ───────────────────────────────────────────────────
  /** Nom validé par regex avant tout accès au disque ; répond 400 sinon. */
  function backupName(req: Request, res: Response): string | null {
    const name = String(req.params.name)
    if (BACKUP_NAME_REGEX.test(name)) return name
    fail(res, 400, 'invalid_name', 'Nom de sauvegarde invalide.')
    return null
  }

  router.get('/backups', (_req, res) => {
    res.json({ ok: true, backups: backups.list() })
  })

  router.post('/backups', async (_req, res) => {
    const backup = await backups.run()
    log('info', 'Sauvegarde créée depuis l’administration', { name: backup.name })
    res.status(201).json({ ok: true, backup })
  })

  router.get('/backups/:name/download', (req, res) => {
    const name = backupName(req, res)
    if (name === null) return
    const file = backups.path(name)
    if (!file) {
      fail(res, 404, 'not_found', 'Sauvegarde introuvable.')
      return
    }
    res.download(file, name)
  })

  router.post('/backups/:name/restore', async (req, res) => {
    const name = backupName(req, res)
    if (name === null) return
    const body: unknown = req.body
    if (!isPlainObject(body) || body.confirm !== true) {
      fail(res, 400, 'confirmation_required', 'Confirmation requise : { "confirm": true }.')
      return
    }
    try {
      await backups.restore(name)
    } catch (err) {
      if (err instanceof BackupError) {
        fail(res, err.code === 'not_found' ? 404 : 400, err.code, err.message)
        return
      }
      throw err
    }
    log('warn', 'Base restaurée depuis une sauvegarde', { name })
    res.json({ ok: true })
  })

  // ── Maintenance et compte ─────────────────────────────────────────
  router.post('/maintenance/vacuum', (_req, res) => {
    db.exec('VACUUM')
    res.json({ ok: true })
  })

  router.post('/password', async (req, res) => {
    const user = res.locals.user as User
    const body: unknown = req.body
    const current = isPlainObject(body) && typeof body.current === 'string' ? body.current : ''
    const next = isPlainObject(body) && typeof body.next === 'string' ? body.next : ''
    if (next.length < MIN_PASSWORD_LENGTH) {
      fail(res, 400, 'invalid_password', PASSWORD_TOO_SHORT, 'next')
      return
    }
    // Réponse générique : on ne distingue pas ancien mot de passe faux et autre échec.
    if (!(await users.verify(user.email, current))) {
      fail(res, 400, 'invalid_password', 'Mot de passe actuel incorrect.', 'current')
      return
    }
    await users.setPassword(user.email, next)
    const cookie = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE]
    sessions.destroyOthers(user.id, cookie)
    log('info', 'Mot de passe administrateur modifié', { user_id: user.id })
    res.json({ ok: true })
  })

  return router
}
