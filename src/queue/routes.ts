import { Router, type NextFunction, type Request, type Response } from 'express'
import { rateLimit } from 'express-rate-limit'
import { newAttachments } from '../files/attachments.js'
import { attachmentSummary, sendUploadError } from '../files/http.js'
import { MultipartError, receiveUpload } from '../files/multipart.js'
import type { OnDownload } from '../files/types.js'
import { UploadError, type UploadManager } from '../files/uploads.js'
import { log } from '../log.js'
import type { Settings } from '../settings/index.js'
import type { NewTag } from '../tags/attach.js'
import { MAX_TAGS_PER_MESSAGE, type TagRegistry } from '../tags/registry.js'
import { normalizeTagName } from '../tags/similarity.js'
import {
  claimedView,
  claimWithWait,
  itemView,
  parseSearch,
  parseTopicParam,
  parseWait,
  queryString,
  TooManyWaitersError,
  type WaitPool,
} from './http.js'
import type { QueueRepo } from './repo.js'
import { checkWebhookSecret } from './secret.js'
import { CORRELATION_ID_REGEX, TOPIC_REGEX } from './validation.js'

/** Longueur maximale de `x-source` (comme le paramètre `source` des outils MCP). */
export const MAX_SOURCE_LENGTH = 100

/** Limite de débit de `GET /next` (requêtes par minute et par IP). */
export const NEXT_RATE_LIMIT_PER_MIN = 600

export function createQueueRouter(deps: {
  repo: QueueRepo
  settings: Settings
  waits: WaitPool
  uploads: UploadManager
  tags: TagRegistry
}): Router {
  const { repo, settings, waits, uploads, tags } = deps
  const router = Router()

  // Le secret est relu à chaque requête : une rotation depuis l'administration est immédiate.
  function auth(req: Request, res: Response, next: NextFunction): void {
    if (!checkWebhookSecret(req, settings)) {
      log('warn', 'Auth refusée', { ip: req.ip, path: req.path })
      res.status(401).json({ ok: false, error: 'Unauthorized' })
      return
    }
    next()
  }

  const webhookLimiter = rateLimit({
    windowMs: 60_000,
    limit: () => settings.get('webhook_rate_limit_per_min'),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { ok: false, error: 'Too many requests' },
  })

  const nextLimiter = rateLimit({
    windowMs: 60_000,
    limit: NEXT_RATE_LIMIT_PER_MIN,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { ok: false, error: 'Too many requests' },
  })

  const isLease = (req: Request) => queryString(req, 'ack') === 'manual'

  // Santé publique (Traefik) : ne divulgue pas la charge de la file.
  router.get('/status', (_req, res) => {
    res.json({ ok: true, uptime_s: Math.floor(process.uptime()) })
  })

  router.post('/webhook', webhookLimiter, auth, async (req, res) => {
    const source = String(req.headers['x-source'] || 'n8n')
    if (source.length > MAX_SOURCE_LENGTH) {
      res.status(400).json({
        ok: false,
        error: 'invalid_source',
        hint: `${MAX_SOURCE_LENGTH} caractères au maximum`,
      })
      return
    }
    const rawCid = String(req.headers['x-correlation-id'] ?? '').trim()
    const correlationId = rawCid.length > 0 ? rawCid : null
    if (correlationId !== null && !CORRELATION_ID_REGEX.test(correlationId)) {
      res.status(400).json({
        ok: false,
        error: 'invalid_correlation_id',
        hint: 'Format attendu : ^[A-Za-z0-9_-]{1,128}$',
      })
      return
    }
    const rawTopic = String(req.headers['x-topic'] ?? '').trim()
    const topic = rawTopic.length > 0 ? rawTopic : 'default'
    if (!TOPIC_REGEX.test(topic)) {
      res.status(400).json({
        ok: false,
        error: 'invalid_topic',
        hint: 'Format attendu : ^[A-Za-z0-9_-]{1,128}$',
      })
      return
    }

    const tagHeader = req.headers['x-tags']
    let tagNames: string[] = []
    let tagInput: { tags: string[]; newTags: NewTag[] } = { tags: [], newTags: [] }
    if (tagHeader !== undefined) {
      const raw = String(tagHeader)
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '')
      if (raw.length > MAX_TAGS_PER_MESSAGE) {
        res.status(400).json({
          ok: false,
          error: 'too_many_tags',
          hint: `${MAX_TAGS_PER_MESSAGE} tags au maximum`,
        })
        return
      }
      // Validation seule : les tags absents sont créés dans la transaction d'enqueue (aucun orphelin).
      const resolved = tags.resolveForHttp(raw, `http:${source}`)
      if (resolved.invalid.length > 0) {
        res.status(400).json({
          ok: false,
          error: 'invalid_tags',
          invalid: resolved.invalid,
          hint: 'Format attendu : ^[a-z0-9][a-z0-9-]{0,47}$',
        })
        return
      }
      tagInput = { tags: resolved.tags, newTags: resolved.newTags }
      tagNames = [...new Set(raw.map(normalizeTagName))]
    }
    let onDownload: OnDownload = settings.get('file_on_download_default')
    const rawOnDownload = req.headers['x-on-download']
    if (rawOnDownload !== undefined) {
      const v = String(rawOnDownload).trim()
      if (v !== 'keep' && v !== 'consume') {
        res.status(400).json({ ok: false, error: 'invalid_on_download', hint: 'keep ou consume' })
        return
      }
      onDownload = v
    }

    const duplicate = (existingId: string | null) => {
      log('warn', 'correlation_id en double', {
        correlation_id: correlationId,
        existing_id: existingId,
      })
      res.status(409).json({
        ok: false,
        error: 'duplicate_correlation_id',
        correlation_id: correlationId,
        existing_id: existingId,
      })
    }

    if (req.is('multipart/form-data')) {
      try {
        const out = await receiveUpload(req, uploads, {
          maxFieldBytes: settings.get('json_max_kb') * 1024,
          prepare(fields) {
            if (fields.payload === undefined || fields.payload === '')
              return { ok: true, value: {} as unknown }
            try {
              return { ok: true, value: JSON.parse(fields.payload) as unknown }
            } catch {
              return { ok: false, status: 400, body: { ok: false, error: 'invalid_json' } }
            }
          },
          write: (payload, files) =>
            repo.enqueue({
              payload,
              source,
              correlationId,
              topic,
              ...tagInput,
              attachments: newAttachments(files, onDownload, settings, Date.now()),
            }),
        })
        if (out.kind === 'rejected') {
          res.status(out.status).json(out.body)
          return
        }
        if (!out.result.ok) {
          duplicate(out.result.existingId)
          return
        }
        const summary = attachmentSummary(out.files)
        log('info', 'Message mis en file avec pièces', {
          id: out.result.id,
          source,
          topic,
          correlation_id: correlationId,
          pending: out.result.pending,
          files: summary.length,
          bytes: summary.reduce((n, f) => n + f.size_bytes, 0),
        })
        res.json({
          ok: true,
          id: out.result.id,
          correlation_id: correlationId,
          pending: out.result.pending,
          topic,
          tags: tagNames,
          attachments: summary,
        })
      } catch (err) {
        if (err instanceof UploadError || err instanceof MultipartError) {
          sendUploadError(res, err)
          return
        }
        throw err
      }
      return
    }

    const result = repo.enqueue({
      payload: req.body ?? {},
      source,
      correlationId,
      topic,
      ...tagInput,
    })
    if (!result.ok) {
      duplicate(result.existingId)
      return
    }
    log('info', 'Message mis en file', {
      id: result.id,
      source,
      topic,
      correlation_id: correlationId,
      pending: result.pending,
    })
    res.json({
      ok: true,
      id: result.id,
      correlation_id: correlationId,
      pending: result.pending,
      topic,
      ...(tagHeader !== undefined ? { tags: tagNames } : {}),
    })
  })

  router.get('/next', nextLimiter, auth, async (req, res) => {
    const topic = parseTopicParam(req)
    if (topic === null) {
      res.status(400).json({ ok: false, error: 'invalid_topic' })
      return
    }
    const waitSec = parseWait(req)
    if (waitSec === null) {
      res
        .status(400)
        .json({ ok: false, error: 'invalid_wait', hint: 'Entier entre 1 et 50 (secondes)' })
      return
    }
    const lease = isLease(req)
    let item
    try {
      item = await claimWithWait({
        repo,
        pool: waits,
        res,
        topic,
        waitSec,
        claim: () => repo.claimNext({ lease, ...(topic !== undefined ? { topic } : {}) }),
      })
    } catch (err) {
      if (!(err instanceof TooManyWaitersError)) throw err
      res.status(429).json({ ok: false, error: 'too_many_waiters' })
      return
    }
    if (res.destroyed) return
    if (!item) {
      res.json({ ok: true, empty: true, item: null })
      return
    }
    log('info', 'Message servi', { id: item.id, topic: item.topic, mode: lease ? 'lease' : 'read' })
    res.json({
      ok: true,
      empty: false,
      item: claimedView(item, settings.get('ttl_hours')),
      pending: repo.stats().pending,
    })
  })

  router.get('/by-id/:correlation_id', auth, (req, res) => {
    const cid = String(req.params.correlation_id ?? '').trim()
    if (!CORRELATION_ID_REGEX.test(cid)) {
      res.status(400).json({ ok: false, error: 'invalid_correlation_id' })
      return
    }
    const peek = req.query.peek === 'true' || req.query.peek === '1'
    if (peek) {
      const msg = repo.findByCorrelation(cid)
      if (!msg) {
        res.status(404).json({ ok: false, error: 'not_found', correlation_id: cid })
        return
      }
      res.json({ ok: true, peek: true, item: itemView(msg) })
      return
    }

    const claimed = repo.claimByCorrelation(cid, { lease: isLease(req) })
    if ('item' in claimed) {
      log('info', 'Message servi par correlation_id', { id: claimed.item.id, correlation_id: cid })
      res.json({
        ok: true,
        empty: false,
        item: claimedView(claimed.item, settings.get('ttl_hours')),
        pending: repo.stats().pending,
      })
    } else if (claimed.error === 'not_found') {
      res.status(404).json({ ok: false, error: 'not_found', correlation_id: cid })
    } else if (claimed.error === 'leased') {
      res.status(409).json({ ok: false, error: 'leased', lease_until: claimed.lease_until })
    } else {
      res.status(410).json({
        ok: false,
        error: 'already_read',
        correlation_id: cid,
        id: claimed.id,
        read_at: claimed.read_at,
      })
    }
  })

  for (const kind of ['ack', 'nack'] as const) {
    router.post(`/${kind}/:leaseId`, auth, (req, res) => {
      const outcome = repo[kind](String(req.params.leaseId))
      if (outcome === 'ok') res.json({ ok: true })
      else {
        const status = outcome === 'invalid_lease' ? 400 : outcome === 'not_found' ? 404 : 409
        res.status(status).json({ ok: false, error: outcome })
      }
    })
  }

  router.get('/peek', auth, (req, res) => {
    const topic = parseTopicParam(req)
    if (topic === null) {
      res.status(400).json({ ok: false, error: 'invalid_topic' })
      return
    }
    const limit = Math.min(Math.max(parseInt(queryString(req, 'limit') ?? '') || 50, 1), 500)
    const offset = Math.max(parseInt(queryString(req, 'offset') ?? '') || 0, 0)
    const opts = topic !== undefined ? { topic } : {}
    res.json({
      ok: true,
      stats: repo.stats(opts),
      limit,
      offset,
      items: repo.peek(limit, offset, opts).map(itemView),
    })
  })

  router.get('/search', auth, (req, res) => {
    const parsed = parseSearch(req)
    if ('invalid' in parsed) {
      res.status(400).json({ ok: false, error: `invalid_${parsed.invalid}` })
      return
    }
    res.json({ ok: true, items: repo.search(parsed.filter).map(itemView) })
  })

  router.get('/stats', auth, (req, res) => {
    const topic = parseTopicParam(req)
    if (topic === null) {
      res.status(400).json({ ok: false, error: 'invalid_topic' })
      return
    }
    res.json({
      ok: true,
      uptime_s: Math.floor(process.uptime()),
      ttl_hours: settings.get('ttl_hours'),
      cleanup_interval_min: settings.get('cleanup_interval_min'),
      stats: repo.stats(topic !== undefined ? { topic } : {}),
    })
  })

  router.delete('/clear', auth, (_req, res) => {
    repo.clear()
    log('warn', 'File vidée sur demande')
    res.json({ ok: true })
  })

  router.delete('/message/:id', auth, (req, res) => {
    const id = String(req.params.id)
    if (!repo.deleteById(id)) {
      res.status(404).json({ ok: false, error: 'Not found' })
      return
    }
    log('info', 'Message supprimé', { id })
    res.json({ ok: true, deleted: id })
  })

  return router
}
