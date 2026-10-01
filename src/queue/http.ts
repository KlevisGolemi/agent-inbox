import type { Request, Response } from 'express'
import type { QueueItem, QueueRepo, SearchFilter } from './repo.js'
import { TOPIC_REGEX } from './validation.js'

const HOUR_MS = 3_600_000
const STATUSES = ['pending', 'leased', 'read'] as const

/** Lit un paramètre de requête texte unique (un tableau ou un objet est traité comme absent). */
export function queryString(req: Request, name: string): string | undefined {
  const v = req.query[name]
  return typeof v === 'string' ? v : undefined
}

/** Vue d'un message pour peek / by-id?peek / search (champs v1 + topic, tentatives, bail). */
export function itemView(m: QueueItem) {
  return {
    id: m.id,
    source: m.source,
    correlation_id: m.correlation_id,
    topic: m.topic,
    status: m.status,
    created_at: m.created_at,
    read_at: m.read_at,
    lease_until: m.lease_until,
    lease_id: m.lease_id,
    attempts: m.attempts,
    payload: m.payload,
  }
}

/** Vue d'un message tout juste emprunté : v1 (lu + delete_at) ou bail manuel (lease_until + attempts). */
export function claimedView(m: QueueItem, ttlHours: number) {
  const base = {
    id: m.id,
    source: m.source,
    correlation_id: m.correlation_id,
    topic: m.topic,
    created_at: m.created_at,
    read_at: m.read_at,
  }
  if (m.status === 'leased') {
    return {
      ...base,
      lease_until: m.lease_until,
      lease_id: m.lease_id,
      attempts: m.attempts,
      payload: m.payload,
    }
  }
  const deleteAt = new Date(new Date(m.read_at!).getTime() + ttlHours * HOUR_MS).toISOString()
  return { ...base, delete_at: deleteAt, payload: m.payload }
}

/** Valide `?topic=` ; renvoie `undefined` si absent, `null` si invalide. */
export function parseTopicParam(req: Request): string | undefined | null {
  const t = queryString(req, 'topic')
  if (t === undefined) return undefined
  return TOPIC_REGEX.test(t) ? t : null
}

/** `?wait=N` : 1–50 s. `undefined` si absent, `null` si invalide. */
export function parseWait(req: Request): number | undefined | null {
  const raw = queryString(req, 'wait')
  if (raw === undefined) return undefined
  if (!/^\d{1,2}$/.test(raw)) return null
  const n = Number(raw)
  return n >= 1 && n <= 50 ? n : null
}

/** Filtres de `GET /search` ; renvoie le nom du paramètre fautif si invalide. */
export function parseSearch(req: Request): { filter: SearchFilter } | { invalid: string } {
  const filter: SearchFilter = {}
  const topic = parseTopicParam(req)
  if (topic === null) return { invalid: 'topic' }
  if (topic !== undefined) filter.topic = topic
  const source = queryString(req, 'source')
  if (source !== undefined) filter.source = source
  const status = queryString(req, 'status')
  if (status !== undefined) {
    if (!(STATUSES as readonly string[]).includes(status)) return { invalid: 'status' }
    filter.status = status as SearchFilter['status']
  }
  for (const key of ['since', 'until'] as const) {
    const raw = queryString(req, key)
    if (raw === undefined) continue
    const ms = Date.parse(raw)
    if (Number.isNaN(ms)) return { invalid: key }
    filter[key] = ms
  }
  const text = queryString(req, 'text')
  if (text !== undefined) filter.text = text
  const limit = queryString(req, 'limit')
  if (limit !== undefined) {
    if (!/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 100)
      return { invalid: 'limit' }
    filter.limit = Number(limit)
  }
  return { filter }
}

/**
 * Tente `claim` ; si rien n'est disponible et que `waitSec` est fourni, attend un enqueue du bon
 * topic (jusqu'à `waitSec` secondes) puis réessaie. Écouteur et minuteur sont libérés dès qu'un
 * message est obtenu, à l'échéance, ou quand `signal` est annulé (client déconnecté).
 */
export function waitForClaim(opts: {
  repo: QueueRepo
  signal?: AbortSignal | undefined
  topic: string | undefined
  waitSec: number | undefined
  claim: () => QueueItem | null
}): Promise<QueueItem | null> {
  const { repo, signal, topic, waitSec, claim } = opts
  const first = claim()
  if (first || waitSec === undefined || signal?.aborted) return Promise.resolve(first)
  return new Promise((resolve) => {
    const finish = (item: QueueItem | null) => {
      off()
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(item)
    }
    const onAbort = () => finish(null)
    const off = repo.onEnqueue((added) => {
      if (topic !== undefined && added.topic !== topic) return
      const item = claim()
      if (item) finish(item)
    })
    const timer = setTimeout(() => finish(null), waitSec * 1000)
    signal?.addEventListener('abort', onAbort)
  })
}

/** Variante HTTP de `waitForClaim` : l'attente s'arrête quand la réponse `res` est fermée. */
export function claimWithWait(opts: {
  repo: QueueRepo
  res: Response
  topic: string | undefined
  waitSec: number | undefined
  claim: () => QueueItem | null
}): Promise<QueueItem | null> {
  const { res, ...rest } = opts
  const ctrl = new AbortController()
  // `res` (et non `req`) : `req` émet « close » dès que le corps est lu, pas à la déconnexion.
  const onClose = () => ctrl.abort()
  res.on('close', onClose)
  return waitForClaim({ ...rest, signal: ctrl.signal }).finally(() => res.off('close', onClose))
}
