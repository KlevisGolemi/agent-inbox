import { timingSafeEqual } from 'node:crypto'
import { Router, type NextFunction, type Request, type Response } from 'express'
import { rateLimit } from 'express-rate-limit'
import { log } from '../log.js'
import type { Settings } from '../settings/index.js'
import {
  claimedView,
  claimWithWait,
  itemView,
  parseSearch,
  parseTopicParam,
  parseWait,
  queryString,
} from './http.js'
import type { QueueRepo } from './repo.js'
import { CORRELATION_ID_REGEX, TOPIC_REGEX } from './validation.js'

export function createQueueRouter(deps: { repo: QueueRepo; settings: Settings }): Router {
  const { repo, settings } = deps
  const router = Router()

  // Le secret est relu à chaque requête : une rotation depuis l'administration est immédiate.
  function auth(req: Request, res: Response, next: NextFunction): void {
    const provided = Buffer.from(String(req.headers['x-webhook-secret'] ?? ''))
    const secret = Buffer.from(settings.get('webhook_secret'))
    if (provided.length !== secret.length || !timingSafeEqual(provided, secret)) {
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

  const isLease = (req: Request) => queryString(req, 'ack') === 'manual'

  // Santé publique (Traefik) : ne divulgue pas la charge de la file.
  router.get('/status', (_req, res) => {
    res.json({ ok: true, uptime_s: Math.floor(process.uptime()) })
  })

  router.post('/webhook', webhookLimiter, auth, (req, res) => {
    const source = req.headers['x-source'] || 'n8n'
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
      res
        .status(400)
        .json({
          ok: false,
          error: 'invalid_topic',
          hint: 'Format attendu : ^[A-Za-z0-9_-]{1,128}$',
        })
      return
    }

    const result = repo.enqueue({
      payload: req.body ?? {},
      source: String(source),
      correlationId,
      topic,
    })
    if (!result.ok) {
      log('warn', 'correlation_id en double', {
        correlation_id: correlationId,
        existing_id: result.existingId,
      })
      res.status(409).json({
        ok: false,
        error: 'duplicate_correlation_id',
        correlation_id: correlationId,
        existing_id: result.existingId,
      })
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
    })
  })

  router.get('/next', auth, async (req, res) => {
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
    const item = await claimWithWait({
      repo,
      res,
      topic,
      waitSec,
      claim: () => repo.claimNext({ lease, ...(topic !== undefined ? { topic } : {}) }),
    })
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
    router.post(`/${kind}/:id`, auth, (req, res) => {
      const outcome = repo[kind](String(req.params.id))
      if (outcome === 'ok') res.json({ ok: true })
      else res.status(outcome === 'not_found' ? 404 : 409).json({ ok: false, error: outcome })
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
