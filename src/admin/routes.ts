import { randomBytes } from 'node:crypto'
import { Router, type NextFunction, type Request, type Response } from 'express'
import { z } from 'zod'
import { BackupError, BACKUP_NAME_REGEX } from '../backups/index.js'
import type { AppDeps } from '../app.js'
import { issueCsrfToken, requireCsrfJson } from '../auth/csrf.js'
import { revokeUserTokens } from '../auth/oauth/provider.js'
import { MIN_PASSWORD_LENGTH, PASSWORD_TOO_SHORT } from '../auth/password.js'
import { SESSION_COOKIE } from '../auth/sessions.js'
import type { User } from '../auth/users.js'
import { createPublicDrop } from '../drops/service.js'
import { inlineKindFor } from '../files/detect.js'
import { sendAttachment } from '../files/http.js'
import { FILE_CATEGORIES } from '../files/types.js'
import { log } from '../log.js'
import { itemView, queryString } from '../queue/http.js'
import { CORRELATION_ID_REGEX, TOPIC_REGEX } from '../queue/validation.js'
import {
  rotateFileSigningSecret,
  SETTING_KEYS,
  SettingValidationError,
  type Settings,
} from '../settings/index.js'

/** Même contrat de dépendances que l'application : un seul type, pas de copie qui dérive. */
export type AdminDeps = AppDeps

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
  return {
    ...all,
    webhook_secret: MASK + all.webhook_secret.slice(-4),
    file_signing_secret: MASK + all.file_signing_secret.slice(-4),
  }
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
  const { backups, files, uploads, attachments, tags, drops } = deps

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
      storage: uploads.snapshot(),
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

  // ── Stockage et pièces jointes ───────────────────────────────────
  router.get('/storage', (_req, res) => {
    res.json({ ok: true, storage: uploads.snapshot() })
  })

  function availableAttachment(req: Request, res: Response) {
    const row = attachments.get(String(req.params.id))
    if (!row || attachments.status(row) !== 'available') {
      fail(res, 404, 'not_found', 'Pièce introuvable ou indisponible.')
      return null
    }
    return row
  }

  // Aperçu : images non actives seulement (jamais SVG) ; mêmes en-têtes de sécurité que le téléchargement.
  router.get('/files/:id/preview', (req, res) => {
    const row = availableAttachment(req, res)
    if (!row) return
    if (inlineKindFor(row.mime_type, row.category) !== 'image') {
      fail(res, 415, 'not_previewable', 'Aperçu réservé aux images.')
      return
    }
    sendAttachment(req, res, row, { files, attachments }, { count: false, disposition: 'inline' })
  })

  router.get('/files/:id/download', (req, res) => {
    const row = availableAttachment(req, res)
    if (row) sendAttachment(req, res, row, { files, attachments }, { count: false })
  })

  router.post('/settings/file-signing-secret/rotate', (_req, res) => {
    rotateFileSigningSecret(settings)
    log('info', 'Secret de signature des liens renouvelé')
    res.json({ ok: true })
  })

  // ── Tags ──────────────────────────────────────────────────────────
  // Les erreurs sont distinguées par leur code (jamais par le message français).
  const tagError = (res: Response, r: { error: string; message: string; similar?: unknown }) =>
    res
      .status(r.error === 'similar_exists' || r.error === 'exists' ? 409 : 400)
      .json({ ok: false, ...r })

  router.get('/tags', (req, res) => {
    const q = queryString(req, 'q')
    res.json({ ok: true, tags: tags.list({ ...(q ? { query: q } : {}), limit: 200 }) })
  })

  router.post('/tags', (req, res) => {
    const b = isPlainObject(req.body) ? req.body : {}
    if (typeof b.name !== 'string' || typeof b.description !== 'string') {
      fail(res, 400, 'invalid_body', 'Champs « name » et « description » obligatoires.')
      return
    }
    const r = tags.create({
      name: b.name,
      description: b.description,
      createdBy: 'admin',
      force: b.force === true,
    })
    if (!r.ok) {
      tagError(res, r)
      return
    }
    res.status(201).json({ ok: true, tag: r.tag })
  })

  router.patch('/tags/:name', (req, res) => {
    const d = isPlainObject(req.body) ? req.body.description : undefined
    if (typeof d !== 'string') {
      fail(res, 400, 'invalid_body', 'Champ « description » obligatoire.')
      return
    }
    const name = String(req.params.name)
    if (!tags.get(name)) {
      fail(res, 404, 'not_found', 'Tag introuvable.')
      return
    }
    const r = tags.updateDescription(name, d)
    if (!r.ok) {
      tagError(res, r)
      return
    }
    res.json({ ok: true, tag: r.tag })
  })

  router.post('/tags/:name/merge', (req, res) => {
    const into = isPlainObject(req.body) ? req.body.into : undefined
    if (typeof into !== 'string') {
      fail(res, 400, 'invalid_body', 'Champ « into » obligatoire.')
      return
    }
    const r = tags.merge(String(req.params.name), into)
    if (!r.ok) {
      if (r.error === 'not_found') fail(res, 404, 'not_found', 'Tag introuvable.')
      else fail(res, 400, 'same_tag', 'Un tag ne peut pas être fusionné avec lui-même.')
      return
    }
    log('info', 'Tags fusionnés', { moved: r.moved })
    res.json({ ok: true, moved: r.moved })
  })

  router.delete('/tags/:name', (req, res) => {
    if (tags.remove(String(req.params.name))) res.json({ ok: true })
    else fail(res, 404, 'not_found', 'Tag introuvable.')
  })

  // ── Liens de dépôt ────────────────────────────────────────────────
  const dropBody = z.object({
    label: z.string().min(1).max(80),
    topic: z.string().optional(),
    tags: z.array(z.string()).max(20).optional(),
    expires_in_hours: z.number().int().min(1).max(720).optional(),
    max_files: z.number().int().min(1).max(1000).optional(),
    max_file_mb: z.number().int().min(1).max(2048).optional(),
    allowed_categories: z.array(z.enum(FILE_CATEGORIES)).min(1).max(6).optional(),
  })

  router.get('/drops', (req, res) => {
    res.json({ ok: true, drops: drops.list({ includeExpired: queryString(req, 'all') === '1' }) })
  })

  router.post('/drops', (req, res) => {
    const parsed = dropBody.safeParse(req.body)
    if (!parsed.success) {
      fail(
        res,
        400,
        'invalid_body',
        parsed.error.issues.map((i) => `${i.path.join('.')} : ${i.message}`).join(' ; '),
      )
      return
    }
    const b = parsed.data
    const r = createPublicDrop(
      { drops, tags, settings, publicUrl: env.publicUrl },
      {
        label: b.label,
        createdBy: 'admin',
        ...(b.topic !== undefined ? { topic: b.topic } : {}),
        ...(b.tags !== undefined ? { tags: b.tags } : {}),
        ...(b.expires_in_hours !== undefined ? { expiresInHours: b.expires_in_hours } : {}),
        ...(b.max_files !== undefined ? { maxFiles: b.max_files } : {}),
        ...(b.max_file_mb !== undefined ? { maxFileMb: b.max_file_mb } : {}),
        ...(b.allowed_categories !== undefined ? { allowedCategories: b.allowed_categories } : {}),
      },
    )
    if (!r.ok) {
      res.status(400).json(r)
      return
    }
    // Ni l'adresse ni le jeton ne sont journalisés.
    log('info', 'Lien de dépôt créé depuis l’administration', { drop_id: r.drop.id })
    res.status(201).json(r)
  })

  router.delete('/drops/:id', (req, res) => {
    if (drops.revoke(String(req.params.id))) res.json({ ok: true })
    else fail(res, 404, 'not_found', 'Lien introuvable ou déjà révoqué.')
  })

  router.get('/drops/:id/events', (req, res) => {
    res.json({ ok: true, events: drops.events(String(req.params.id)) })
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
    const revoked = revokeUserTokens(db, user.id)
    log('info', 'Mot de passe administrateur modifié', { user_id: user.id, oauth_revoked: revoked })
    res.json({ ok: true })
  })

  return router
}
