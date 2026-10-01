import type { AddressInfo } from 'node:net'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app.js'
import { createWaitPool } from '../src/queue/http.js'
import { createQueueRepo } from '../src/queue/repo.js'
import { makeAppDeps, makeTestApp, testDb } from './helpers/app.js'

const HEADERS = {
  accept: 'application/json, text/event-stream',
  'content-type': 'application/json',
}

/** Corps JSON-RPC d'une réponse JSON ou SSE (lignes `data:`). */
/** Corps JSON-RPC non typé : les tests en inspectent des champs arbitraires. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Rpc = any

function rpcBody(res: request.Response): Rpc {
  if (res.body && Object.keys(res.body).length > 0) return res.body
  const line = res.text.split('\n').find((l) => l.startsWith('data:'))
  return JSON.parse(line!.slice(5).trim())
}

function setup() {
  const t = makeTestApp()
  const { key } = t.apiKeys.create('test')
  return { ...t, key }
}

type Ctx = { app: Parameters<typeof request>[0]; key: string }
let seq = 0
async function rpc(ctx: Ctx, method: string, params?: unknown) {
  const res = await request(ctx.app)
    .post('/mcp')
    .set(HEADERS)
    .set('authorization', `Bearer ${ctx.key}`)
    .send({ jsonrpc: '2.0', id: ++seq, method, params })
  return { res, body: rpcBody(res) }
}

/** Appelle un outil et renvoie son résultat (`result` JSON-RPC). */
async function call(ctx: Ctx, name: string, args: Record<string, unknown> = {}) {
  const { body } = await rpc(ctx, 'tools/call', { name, arguments: args })
  return body
}

/** Données métier d'un résultat d'outil (structuredContent). */
const data = (body: Rpc) => body.result.structuredContent

describe('MCP stateless', () => {
  it('refuse sans Authorization : 401 + WWW-Authenticate', async () => {
    const { app } = setup()
    const res = await request(app)
      .post('/mcp')
      .set(HEADERS)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(res.status).toBe(401)
    expect(res.headers['www-authenticate']).toMatch(/Bearer/)
  })

  it('initialize : 200 sans mcp-session-id', async () => {
    const ctx = setup()
    const { res, body } = await rpc(ctx, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 't', version: '1' },
    })
    expect(res.status).toBe(200)
    expect(res.headers['mcp-session-id']).toBeUndefined()
    expect(body.result.serverInfo).toMatchObject({ name: 'cowork-queue', version: '0.0.0-test' })
  })

  it('tools/list sans initialize préalable : 12 outils', async () => {
    const ctx = setup()
    const { res, body } = await rpc(ctx, 'tools/list')
    expect(res.status).toBe(200)
    const names = body.result.tools.map((t: { name: string }) => t.name).sort()
    expect(names).toEqual(
      [
        'queue_ack',
        'queue_by_id',
        'queue_clear',
        'queue_delete',
        'queue_next',
        'queue_nack',
        'queue_peek',
        'queue_search',
        'queue_send',
        'queue_stats',
        'queue_status',
        'queue_wait',
      ].sort(),
    )
  })

  it('queue_status renvoie ok, uptime_s et version', async () => {
    const ctx = setup()
    const out = data(await call(ctx, 'queue_status'))
    expect(out).toMatchObject({ ok: true, version: '0.0.0-test' })
    expect(typeof out.uptime_s).toBe('number')
  })

  it('queue_send puis queue_peek : message visible, source claude par défaut', async () => {
    const ctx = setup()
    const sent = data(await call(ctx, 'queue_send', { payload: { a: 1 }, correlation_id: 'c1' }))
    expect(sent.ok).toBe(true)
    const peek = data(await call(ctx, 'queue_peek', {}))
    expect(peek.items).toHaveLength(1)
    expect(peek.items[0]).toMatchObject({
      source: 'claude',
      correlation_id: 'c1',
      payload: { a: 1 },
    })
  })

  it('queue_send : correlation_id en double → isError', async () => {
    const ctx = setup()
    await call(ctx, 'queue_send', { payload: {}, correlation_id: 'dup' })
    const body = await call(ctx, 'queue_send', { payload: {}, correlation_id: 'dup' })
    expect(body.result.isError).toBe(true)
    expect(data(body)).toMatchObject({ error: 'duplicate_correlation_id' })
  })

  it('queue_by_id sans peek (défaut true) laisse le message pending', async () => {
    const ctx = setup()
    await call(ctx, 'queue_send', { payload: { x: 1 }, correlation_id: 'k1' })
    const got = data(await call(ctx, 'queue_by_id', { correlation_id: 'k1' }))
    expect(got.item.status).toBe('pending')
    const again = data(await call(ctx, 'queue_by_id', { correlation_id: 'k1' }))
    expect(again.item.status).toBe('pending')
  })

  it('queue_by_id peek:false emprunte ; inconnu → not_found', async () => {
    const ctx = setup()
    await call(ctx, 'queue_send', { payload: {}, correlation_id: 'k2' })
    const got = data(await call(ctx, 'queue_by_id', { correlation_id: 'k2', peek: false }))
    expect(got.item.lease_id).toMatch(/\.1$/)
    const miss = await call(ctx, 'queue_by_id', { correlation_id: 'nope' })
    expect(miss.result.isError).toBe(true)
    expect(data(miss).error).toBe('not_found')
  })

  it('queue_next → queue_ack → message read', async () => {
    const ctx = setup()
    await call(ctx, 'queue_send', { payload: { n: 1 }, correlation_id: 'n1' })
    const next = data(await call(ctx, 'queue_next'))
    expect(next.empty).toBe(false)
    expect(next.item.lease_id).toBeTruthy()
    const ack = await call(ctx, 'queue_ack', { lease_id: next.item.lease_id })
    expect(data(ack)).toMatchObject({ ok: true })
    const peek = data(await call(ctx, 'queue_peek', {}))
    expect(peek.items[0].status).toBe('read')
    expect(data(await call(ctx, 'queue_next')).empty).toBe(true)
    const again = await call(ctx, 'queue_ack', { lease_id: next.item.lease_id })
    expect(again.result.isError).toBe(true)
    expect(data(again).error).toBe('not_leased')
  })

  it('queue_ack : lease_id invalide / inconnu → isError', async () => {
    const ctx = setup()
    const bad = await call(ctx, 'queue_ack', { lease_id: 'zzz' })
    expect(bad.result.isError).toBe(true)
    expect(data(bad).error).toBe('invalid_lease')
    const miss = await call(ctx, 'queue_nack', {
      lease_id: '00000000-0000-4000-8000-000000000000.1',
    })
    expect(data(miss).error).toBe('not_found')
  })

  it('queue_nack remet le message en pending', async () => {
    const ctx = setup()
    await call(ctx, 'queue_send', { payload: {} })
    const next = data(await call(ctx, 'queue_next'))
    expect(data(await call(ctx, 'queue_nack', { lease_id: next.item.lease_id })).ok).toBe(true)
    expect(data(await call(ctx, 'queue_peek', {})).items[0].status).toBe('pending')
  })

  it('queue_next sans ack : re-servi après expiration du bail', async () => {
    let t = 1_000_000
    const db = testDb()
    const repo = createQueueRepo(db, { now: () => t, leaseTimeoutMs: () => 60_000 })
    const deps = makeAppDeps({ db, repo })
    const ctx = { app: createApp(deps), key: deps.apiKeys.create('t').key }
    await call(ctx, 'queue_send', { payload: { p: 1 } })
    const first = data(await call(ctx, 'queue_next'))
    expect(first.item.attempts).toBe(1)
    expect(data(await call(ctx, 'queue_next')).empty).toBe(true)
    t += 61_000
    const second = data(await call(ctx, 'queue_next'))
    expect(second.item.id).toBe(first.item.id)
    expect(second.item.attempts).toBe(2)
  })

  it('topic : send/next/peek/stats filtrent par topic', async () => {
    const ctx = setup()
    await call(ctx, 'queue_send', { payload: { a: 1 }, topic: 'a' })
    await call(ctx, 'queue_send', { payload: { b: 1 }, topic: 'b' })
    expect(data(await call(ctx, 'queue_peek', { topic: 'b' })).items).toHaveLength(1)
    expect(data(await call(ctx, 'queue_stats', { topic: 'a' })).stats.total).toBe(1)
    const next = data(await call(ctx, 'queue_next', { topic: 'b' }))
    expect(next.item.topic).toBe('b')
  })

  it('queue_search filtre par texte', async () => {
    const ctx = setup()
    await call(ctx, 'queue_send', { payload: { word: 'needle' } })
    await call(ctx, 'queue_send', { payload: { word: 'hay' } })
    const out = data(await call(ctx, 'queue_search', { text: 'needle' }))
    expect(out.items).toHaveLength(1)
  })

  it('queue_wait : réveillé par un enqueue concurrent, avec lease_id', async () => {
    const ctx = setup()
    const waiting = call(ctx, 'queue_wait', { timeout_sec: 10 })
    await new Promise((r) => setTimeout(r, 200))
    ctx.repo.enqueue({ payload: { hello: 1 }, source: 'n8n', correlationId: null })
    const out = data(await waiting)
    expect(out.empty).toBe(false)
    expect(out.item.payload).toEqual({ hello: 1 })
    expect(out.item.lease_id).toBeTruthy()
  })

  it('queue_wait : au-delà du plafond d’attentes → isError too_many_waiters', async () => {
    const waits = createWaitPool({ max: 1 })
    const t = makeTestApp({ waits })
    const ctx = { app: t.app, key: t.apiKeys.create('test').key }
    const waiting = call(ctx, 'queue_wait', { timeout_sec: 2 })
    await vi.waitFor(() => expect(waits.active).toBe(1))
    const body = await call(ctx, 'queue_wait', { timeout_sec: 2 })
    expect(body.result.isError).toBe(true)
    expect(data(body)).toMatchObject({ ok: false, error: 'too_many_waiters' })
    expect(data(await waiting).empty).toBe(true)
  })

  it('queue_wait : l’arrêt du serveur résout l’attente en { empty: true }', async () => {
    const ctrl = new AbortController()
    const waits = createWaitPool({ signal: ctrl.signal })
    const t = makeTestApp({ waits })
    const ctx = { app: t.app, key: t.apiKeys.create('test').key }
    const waiting = call(ctx, 'queue_wait', { timeout_sec: 50 })
    await vi.waitFor(() => expect(waits.active).toBe(1))
    const t0 = Date.now()
    ctrl.abort()
    expect(data(await waiting).empty).toBe(true)
    expect(Date.now() - t0).toBeLessThan(500)
  })

  it('lease_id absent de queue_peek, queue_search et queue_by_id (peek)', async () => {
    const ctx = setup()
    await call(ctx, 'queue_send', { payload: { a: 1 }, correlation_id: 'c1' })
    expect(data(await call(ctx, 'queue_next')).item.lease_id).toBeTruthy()
    const views = [
      data(await call(ctx, 'queue_peek')).items[0],
      data(await call(ctx, 'queue_search')).items[0],
      data(await call(ctx, 'queue_by_id', { correlation_id: 'c1' })).item,
    ]
    for (const view of views) {
      expect(view.status).toBe('leased')
      expect(view).not.toHaveProperty('lease_id')
    }
  })

  it('queue_peek : limit plafonné à 100', async () => {
    const ctx = setup()
    expect(data(await call(ctx, 'queue_peek', { limit: 100 })).limit).toBe(100)
    expect((await call(ctx, 'queue_peek', { limit: 101 })).result.isError).toBe(true)
  })

  it('erreurs de validation des arguments en français', async () => {
    const ctx = setup()
    const body = await call(ctx, 'queue_search', { limit: 1000 })
    const text = JSON.stringify(body)
    expect(text).toContain('Trop grand')
    expect(text).not.toContain('Too big')
  })

  it('queue_wait : timeout → { empty: true } sans erreur', async () => {
    const ctx = setup()
    const body = await call(ctx, 'queue_wait', { timeout_sec: 1 })
    expect(body.result.isError).toBeFalsy()
    expect(data(body)).toMatchObject({ empty: true })
  })

  it('queue_wait : topic et correlation_id exclusifs', async () => {
    const ctx = setup()
    const body = await call(ctx, 'queue_wait', { topic: 'a', correlation_id: 'b', timeout_sec: 1 })
    expect(body.result.isError).toBe(true)
  })

  it('queue_wait par correlation_id : emprunte le message ciblé', async () => {
    const ctx = setup()
    const waiting = call(ctx, 'queue_wait', { correlation_id: 'wanted', timeout_sec: 10 })
    await new Promise((r) => setTimeout(r, 200))
    ctx.repo.enqueue({ payload: { z: 0 }, source: 'n8n', correlationId: 'other' })
    ctx.repo.enqueue({ payload: { z: 1 }, source: 'n8n', correlationId: 'wanted' })
    const out = data(await waiting)
    expect(out.item.correlation_id).toBe('wanted')
    expect(out.item.lease_id).toBeTruthy()
  })

  it('queue_delete supprime ; inconnu → isError', async () => {
    const ctx = setup()
    const sent = data(await call(ctx, 'queue_send', { payload: {} }))
    expect(data(await call(ctx, 'queue_delete', { id: sent.id })).ok).toBe(true)
    const again = await call(ctx, 'queue_delete', { id: sent.id })
    expect(again.result.isError).toBe(true)
  })

  it('queue_clear sans confirm → erreur de validation ; avec confirm vide la file', async () => {
    const ctx = setup()
    await call(ctx, 'queue_send', { payload: {} })
    const refused = await call(ctx, 'queue_clear', {})
    expect(refused.result.isError).toBe(true)
    expect(refused.result.content[0].text).toMatch(/confirm/i)
    expect(data(await call(ctx, 'queue_stats')).stats.total).toBe(1)
    const ok = await call(ctx, 'queue_clear', { confirm: true })
    expect(data(ok).ok).toBe(true)
    expect(data(await call(ctx, 'queue_stats')).stats.total).toBe(0)
  })

  it('redémarrage simulé : app recréée sur la même base, tools/list fonctionne', async () => {
    const first = setup()
    await call(first, 'queue_send', { payload: { keep: 1 } })
    const app2 = createApp(makeAppDeps({ ...first, repo: createQueueRepo(first.db) }))
    const ctx2 = { app: app2, key: first.key }
    const { res, body } = await rpc(ctx2, 'tools/list')
    expect(res.status).toBe(200)
    expect(body.result.tools).toHaveLength(12)
    expect(data(await call(ctx2, 'queue_peek', {})).items).toHaveLength(1)
  })

  it('GET et DELETE /mcp → 405 JSON-RPC', async () => {
    const { app } = setup()
    for (const m of ['get', 'delete'] as const) {
      const res = await request(app)[m]('/mcp')
      expect(res.status).toBe(405)
      expect(res.body).toMatchObject({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed' },
      })
    }
  })

  it('CORS : préflight OPTIONS et en-têtes exposés, limités à /mcp', async () => {
    const { app } = setup()
    const pre = await request(app)
      .options('/mcp')
      .set('origin', 'https://claude.ai')
      .set('access-control-request-method', 'POST')
    expect(pre.status).toBe(204)
    expect(pre.headers['access-control-allow-origin']).toBe('*')
    expect(pre.headers['access-control-allow-methods']).toMatch(/POST/)
    for (const h of ['Authorization', 'Content-Type', 'MCP-Protocol-Version', 'Mcp-Session-Id'])
      expect(pre.headers['access-control-allow-headers']?.toLowerCase()).toContain(h.toLowerCase())
    const unauth = await request(app).post('/mcp').set(HEADERS).send({})
    expect(unauth.headers['access-control-allow-origin']).toBe('*')
    expect(unauth.headers['access-control-expose-headers']).toMatch(/WWW-Authenticate/i)
    const other = await request(app).get('/healthz')
    expect(other.headers['access-control-allow-origin']).toBeUndefined()
  })
})

describe('POST /mcp : limite de débit', () => {
  it('600 requêtes/min/IP, puis 429 avec une erreur JSON-RPC', async () => {
    const { app } = setup()
    const server = app.listen(0)
    const { port } = server.address() as AddressInfo
    const send = () =>
      fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      })
    const statuses: number[] = []
    for (let i = 0; i < 12; i++) {
      statuses.push(
        ...(await Promise.all(Array.from({ length: 50 }, () => send().then((r) => r.status)))),
      )
    }
    expect(statuses.every((s) => s === 401)).toBe(true)
    const over = await send()
    expect(over.status).toBe(429)
    expect(await over.json()).toMatchObject({
      jsonrpc: '2.0',
      error: { code: -32000, message: expect.any(String) },
      id: null,
    })
    server.close()
  })
})
