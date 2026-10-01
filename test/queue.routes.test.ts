import type { AddressInfo } from 'node:net'
import http from 'node:http'
import type Database from 'better-sqlite3'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app.js'
import { openDb } from '../src/db/index.js'
import { migrate } from '../src/db/migrations.js'
import { createQueueRepo, type QueueRepo } from '../src/queue/repo.js'
import { createSettings, seedSettings, type Settings } from '../src/settings/index.js'

const SECRET = 's'.repeat(40)
const H = { 'x-webhook-secret': SECRET }

let db: Database.Database
let settings: Settings
let repo: QueueRepo
let clock: number
let app: ReturnType<typeof createApp>

beforeEach(() => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  db = openDb(':memory:')
  migrate(db, () => {})
  settings = createSettings(db)
  seedSettings(settings, db, { webhookSecret: SECRET }, () => 'g'.repeat(64))
  clock = Date.now()
  repo = createQueueRepo(db, {
    now: () => clock,
    leaseTimeoutMs: () => settings.get('lease_timeout_sec') * 1000,
  })
  app = createApp({ db, settings, repo, version: '9.9.9' })
})

const post = (body: unknown = { a: 1 }, headers: Record<string, string> = {}) =>
  request(app)
    .post('/webhook')
    .set(H)
    .set(headers)
    .send(body as object)

describe('authentification', () => {
  it('401 sans secret et avec un mauvais secret', async () => {
    const r1 = await request(app).get('/next')
    expect(r1.status).toBe(401)
    expect(r1.body).toEqual({ ok: false, error: 'Unauthorized' })
    const r2 = await request(app).get('/next').set('x-webhook-secret', 'x'.repeat(40))
    expect(r2.status).toBe(401)
  })

  it("le secret changé à chaud refuse immédiatement l'ancien", async () => {
    expect((await request(app).get('/stats').set(H)).status).toBe(200)
    settings.set('webhook_secret', 'n'.repeat(40))
    expect((await request(app).get('/stats').set(H)).status).toBe(401)
    expect((await request(app).get('/stats').set('x-webhook-secret', 'n'.repeat(40))).status).toBe(
      200,
    )
  })

  it('/status et /healthz sont publics', async () => {
    const s = await request(app).get('/status')
    expect(s.status).toBe(200)
    expect(s.body).toMatchObject({ ok: true })
    expect(typeof s.body.uptime_s).toBe('number')
    const h = await request(app).get('/healthz')
    expect(h.body).toMatchObject({ ok: true, version: '9.9.9' })
  })

  it('pose les en-têtes de sécurité', async () => {
    const r = await request(app).get('/status')
    expect(r.headers['x-content-type-options']).toBe('nosniff')
    expect(r.headers['referrer-policy']).toBe('no-referrer')
    expect(r.headers['content-security-policy']).toBe("frame-ancestors 'none'")
    expect(r.headers['x-powered-by']).toBeUndefined()
  })
})

describe('POST /webhook', () => {
  it('met en file avec le corps v1 + topic', async () => {
    const r = await post({ hello: 'w' }, { 'x-correlation-id': 'c-1', 'x-source': 'zap' })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({
      ok: true,
      id: expect.any(String),
      correlation_id: 'c-1',
      pending: 1,
      topic: 'default',
    })
    const next = await request(app).get('/next').set(H)
    expect(next.body.item).toMatchObject({
      source: 'zap',
      correlation_id: 'c-1',
      payload: { hello: 'w' },
    })
  })

  it('400 sur correlation_id invalide avec hint', async () => {
    const r = await post({}, { 'x-correlation-id': 'a b!' })
    expect(r.status).toBe(400)
    expect(r.body).toEqual({
      ok: false,
      error: 'invalid_correlation_id',
      hint: 'Format attendu : ^[A-Za-z0-9_-]{1,128}$',
    })
  })

  it('400 sur topic invalide', async () => {
    const r = await post({}, { 'x-topic': 'a b' })
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('invalid_topic')
  })

  it('409 sur doublon avec existing_id', async () => {
    const first = await post({}, { 'x-correlation-id': 'dup' })
    const r = await post({}, { 'x-correlation-id': 'dup' })
    expect(r.status).toBe(409)
    expect(r.body).toEqual({
      ok: false,
      error: 'duplicate_correlation_id',
      correlation_id: 'dup',
      existing_id: first.body.id,
    })
  })

  it('413 en JSON au-delà de 1 Mo', async () => {
    const r = await post({ big: 'x'.repeat(2 * 1024 * 1024) })
    expect(r.status).toBe(413)
    expect(r.body).toEqual({ ok: false, error: 'payload_too_large' })
  })

  it('accepte un corps non JSON comme objet vide (comme v1)', async () => {
    const r = await request(app)
      .post('/webhook')
      .set(H)
      .set('content-type', 'text/plain')
      .send('hi')
    expect(r.status).toBe(200)
    expect((await request(app).get('/next').set(H)).body.item.payload).toEqual({})
  })

  it('429 une fois la limite (réglée à chaud) dépassée', async () => {
    settings.set('webhook_rate_limit_per_min', 2)
    expect((await post()).status).toBe(200)
    expect((await post()).status).toBe(200)
    const r = await post()
    expect(r.status).toBe(429)
    expect(r.body).toEqual({ ok: false, error: 'Too many requests' })
  })
})

describe('GET /next', () => {
  it('vide → empty', async () => {
    const r = await request(app).get('/next').set(H)
    expect(r.body).toEqual({ ok: true, empty: true, item: null })
  })

  it('corps v1 : lu immédiatement avec delete_at', async () => {
    await post({ n: 1 })
    settings.set('ttl_hours', 10)
    const r = await request(app).get('/next').set(H)
    expect(r.body).toMatchObject({ ok: true, empty: false, pending: 0 })
    expect(Object.keys(r.body.item).sort()).toEqual([
      'correlation_id',
      'created_at',
      'delete_at',
      'id',
      'payload',
      'read_at',
      'source',
      'topic',
    ])
    expect(
      new Date(r.body.item.delete_at).getTime() - new Date(r.body.item.read_at).getTime(),
    ).toBe(10 * 3_600_000)
    expect((await request(app).get('/next').set(H)).body.empty).toBe(true)
  })

  it('?topic= ne sert que ce topic', async () => {
    await post({ n: 1 }, { 'x-topic': 'a' })
    await post({ n: 2 }, { 'x-topic': 'b' })
    const r = await request(app).get('/next?topic=b').set(H)
    expect(r.body.item.payload).toEqual({ n: 2 })
    expect((await request(app).get('/next?topic=b').set(H)).body.empty).toBe(true)
  })

  it('?ack=manual emprunte, puis ack termine', async () => {
    await post({ n: 1 })
    const r = await request(app).get('/next?ack=manual').set(H)
    expect(r.body.item).toMatchObject({ attempts: 1, read_at: null })
    expect(r.body.item.lease_until).toBe(new Date(clock + 300_000).toISOString())
    expect(r.body.item.lease_id).toBe(`${r.body.item.id}.1`)
    const ack = await request(app).post(`/ack/${r.body.item.lease_id}`).set(H)
    expect(ack.status).toBe(200)
    expect(ack.body).toEqual({ ok: true })
    expect((await request(app).post(`/ack/${r.body.item.lease_id}`).set(H)).status).toBe(409)
  })

  it('bail expiré : message re-servi avec attempts 2', async () => {
    await post({ n: 1 })
    await request(app).get('/next?ack=manual').set(H)
    expect((await request(app).get('/next?ack=manual').set(H)).body.empty).toBe(true)
    clock += 301_000
    const r = await request(app).get('/next?ack=manual').set(H)
    expect(r.body.item.attempts).toBe(2)
  })

  it('nack remet en attente ; ack/nack : 400, 404 et 409', async () => {
    const id = (await post({ n: 1 })).body.id
    expect((await request(app).post(`/ack/${id}.1`).set(H)).body).toEqual({
      ok: false,
      error: 'not_leased',
    })
    expect(
      (await request(app).post('/nack/00000000-0000-4000-8000-000000000000.1').set(H)).status,
    ).toBe(404)
    const bad = await request(app).post('/ack/malformed').set(H)
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBe('invalid_lease')
    expect((await request(app).post('/nack/abc.x').set(H)).status).toBe(400)
    expect((await request(app).post('/ack/abc.1').set(H)).body.error).toBe('invalid_lease')
    expect((await request(app).post(`/ack/${id}.0`).set(H)).status).toBe(400)
    await request(app).get('/next?ack=manual').set(H)
    expect((await request(app).post(`/nack/${id}.1`).set(H)).status).toBe(200)
    expect((await request(app).get('/next').set(H)).body.item.id).toBe(id)
  })

  it('ack avec un lease_id dépassé par un re-claim : 409, bail courant intact', async () => {
    await post({ n: 1 })
    const first = (await request(app).get('/next?ack=manual').set(H)).body.item
    clock += 301_000
    const second = (await request(app).get('/next?ack=manual').set(H)).body.item
    expect(second.attempts).toBe(2)
    const stale = await request(app).post(`/ack/${first.lease_id}`).set(H)
    expect(stale.status).toBe(409)
    expect(stale.body.error).toBe('not_leased')
    expect(repo.stats().leased).toBe(1)
    expect((await request(app).post(`/ack/${second.lease_id}`).set(H)).status).toBe(200)
  })

  it("ack d'un bail expiré non ré-emprunté : 200", async () => {
    await post({ n: 1 })
    const item = (await request(app).get('/next?ack=manual').set(H)).body.item
    clock += 301_000
    expect((await request(app).post(`/ack/${item.lease_id}`).set(H)).status).toBe(200)
  })

  it('400 sur wait ou topic invalide', async () => {
    for (const q of ['wait=0', 'wait=51', 'wait=abc', 'topic=a%20b'])
      expect((await request(app).get(`/next?${q}`).set(H)).status).toBe(400)
  })

  it('?wait=2 est réveillé par un enqueue concurrent en moins de 500 ms', async () => {
    const t0 = Date.now()
    setTimeout(
      () => repo.enqueue({ payload: { late: true }, source: 't', correlationId: null }),
      100,
    )
    const r = await request(app).get('/next?wait=2').set(H)
    expect(r.body.item.payload).toEqual({ late: true })
    expect(Date.now() - t0).toBeLessThan(500)
  })

  it('?wait=1 sans message renvoie empty après ~1 s ; un autre topic ne réveille pas', async () => {
    const t0 = Date.now()
    setTimeout(
      () => repo.enqueue({ payload: {}, source: 't', correlationId: null, topic: 'other' }),
      100,
    )
    const r = await request(app).get('/next?wait=1&topic=mine').set(H)
    expect(r.body).toEqual({ ok: true, empty: true, item: null })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900)
  })
})

describe('wait : déconnexion du client', () => {
  it("libère l'écouteur quand le client se déconnecte", async () => {
    let active = 0
    const orig = repo.onEnqueue.bind(repo)
    repo.onEnqueue = (l) => {
      active++
      const off = orig(l)
      return () => {
        active--
        off()
      }
    }
    const server = app.listen(0)
    const { port } = server.address() as AddressInfo
    const req = http.get({ port, path: '/next?wait=30', headers: H })
    req.on('error', () => {})
    await vi.waitFor(() => expect(active).toBe(1))
    req.destroy()
    await vi.waitFor(() => expect(active).toBe(0))
    server.close()
  })
})

describe('GET /by-id/:cid', () => {
  it('404, 400, claim, puis 410', async () => {
    expect((await request(app).get('/by-id/nope').set(H)).status).toBe(404)
    expect((await request(app).get('/by-id/a%20b').set(H)).body.error).toBe(
      'invalid_correlation_id',
    )
    await post({ n: 1 }, { 'x-correlation-id': 'c1' })
    const ok = await request(app).get('/by-id/c1').set(H)
    expect(ok.body.item.payload).toEqual({ n: 1 })
    expect(ok.body.item.delete_at).toBeTruthy()
    const gone = await request(app).get('/by-id/c1').set(H)
    expect(gone.status).toBe(410)
    expect(gone.body).toMatchObject({
      ok: false,
      error: 'already_read',
      correlation_id: 'c1',
      id: ok.body.item.id,
    })
    expect(gone.body.read_at).toBeTruthy()
  })

  it('?peek=true est non destructif', async () => {
    await post({ n: 1 }, { 'x-correlation-id': 'c1' })
    const p = await request(app).get('/by-id/c1?peek=true').set(H)
    expect(p.body).toMatchObject({
      ok: true,
      peek: true,
      item: { status: 'pending', read_at: null },
    })
    expect((await request(app).get('/by-id/c1').set(H)).status).toBe(200)
    expect((await request(app).get('/by-id/zz?peek=1').set(H)).status).toBe(404)
  })

  it('409 leased quand emprunté et non expiré', async () => {
    await post({ n: 1 }, { 'x-correlation-id': 'c1' })
    const l = await request(app).get('/by-id/c1?ack=manual').set(H)
    expect(l.body.item.attempts).toBe(1)
    const r = await request(app).get('/by-id/c1').set(H)
    expect(r.status).toBe(409)
    expect(r.body).toEqual({ ok: false, error: 'leased', lease_until: l.body.item.lease_until })
  })
})

describe('peek, stats, suppression, search', () => {
  it('GET /peek pagine et renvoie les stats', async () => {
    for (let i = 0; i < 3; i++) {
      await post({ i })
      clock += 1
    }
    const r = await request(app).get('/peek?limit=2&offset=1').set(H)
    expect(r.body).toMatchObject({ ok: true, limit: 2, offset: 1 })
    expect(r.body.stats).toMatchObject({ total: 3, pending: 3, read_count: 0 })
    expect(r.body.items.map((m: { payload: { i: number } }) => m.payload.i)).toEqual([1, 0])
  })

  it('GET /stats', async () => {
    settings.set('ttl_hours', 12)
    await post()
    const r = await request(app).get('/stats').set(H)
    expect(r.body).toMatchObject({
      ok: true,
      ttl_hours: 12,
      cleanup_interval_min: 60,
      stats: { total: 1, pending: 1, read_count: 0, leased: 0, topics: { default: 1 } },
    })
    expect(typeof r.body.uptime_s).toBe('number')
  })

  it('DELETE /message/:id et /clear', async () => {
    const id = (await post()).body.id
    const del = await request(app).delete(`/message/${id}`).set(H)
    expect(del.body).toEqual({ ok: true, deleted: id })
    const nf = await request(app).delete(`/message/${id}`).set(H)
    expect(nf.status).toBe(404)
    expect(nf.body).toEqual({ ok: false, error: 'Not found' })
    await post()
    expect((await request(app).delete('/clear').set(H)).body).toEqual({ ok: true })
    expect(repo.stats().total).toBe(0)
  })

  it('GET /search filtre et valide', async () => {
    await post({ msg: '100% ok' }, { 'x-topic': 'a', 'x-source': 'z' })
    await post({ msg: 'autre' }, { 'x-topic': 'b' })
    const r = await request(app).get('/search?topic=a&source=z&status=pending&text=100%25').set(H)
    expect(r.body.ok).toBe(true)
    expect(r.body.items).toHaveLength(1)
    const since = new Date(clock - 60_000).toISOString()
    expect(
      (
        await request(app)
          .get(`/search?since=${encodeURIComponent(since)}`)
          .set(H)
      ).body.items,
    ).toHaveLength(2)
    expect((await request(app).get('/search?limit=1').set(H)).body.items).toHaveLength(1)
    for (const q of ['limit=0', 'limit=101', 'since=nope', 'status=bad', 'topic=a%20b'])
      expect((await request(app).get(`/search?${q}`).set(H)).status).toBe(400)
    expect((await request(app).get('/search')).status).toBe(401)
  })
})
