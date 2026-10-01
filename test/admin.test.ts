import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { SESSION_COOKIE } from '../src/auth/sessions.js'
import type { AppDeps } from '../src/app.js'
import { getSetCookie, makeTestApp, testEnv } from './helpers/app.js'

const EMAIL = 'admin@example.test'
const PASSWORD = 'mot-de-passe-initial-1'

/** Application de test avec un admin connecté ; `cookies` porte session + CSRF. */
async function setup() {
  return setupWith()
}

async function setupWith(over: Partial<AppDeps> = {}) {
  const ctx = makeTestApp(over)
  const user = await ctx.users.create(EMAIL, PASSWORD)
  const session = ctx.sessions.create(user.id)
  const base = `${SESSION_COOKIE}=${session}`
  const overview = await request(ctx.app).get('/admin/api/overview').set('Cookie', base)
  const csrf = overview.body.csrfToken as string
  const cookies = `${base}; cq_csrf=${csrf}`
  const api = (method: 'post' | 'patch' | 'delete' | 'get', path: string) =>
    request(ctx.app)[method](`/admin/api${path}`).set('Cookie', cookies).set('x-csrf-token', csrf)
  return { ...ctx, user, session, base, csrf, cookies, api }
}

describe('accès et CSRF', () => {
  it('renvoie 401 JSON sans session', async () => {
    const { app } = makeTestApp()
    const res = await request(app).get('/admin/api/overview').set('Accept', 'application/json')
    expect(res.status).toBe(401)
    expect(res.body.ok).toBe(false)
  })

  it('refuse une mutation sans jeton CSRF (403) et ne modifie rien', async () => {
    const { app, base, settings } = await setup()
    const res = await request(app)
      .patch('/admin/api/settings')
      .set('Cookie', base)
      .send({ ttl_hours: 12 })
    expect(res.status).toBe(403)
    expect(settings.get('ttl_hours')).toBe(48)
  })

  it('refuse une mutation avec un jeton CSRF qui ne correspond pas au cookie', async () => {
    const { app, cookies } = await setup()
    const res = await request(app)
      .delete('/admin/api/messages')
      .set('Cookie', cookies)
      .set('x-csrf-token', 'A'.repeat(43))
      .send({ confirm: true })
    expect(res.status).toBe(403)
  })

  it('GET / redirige vers /admin', async () => {
    const { app } = makeTestApp()
    const res = await request(app).get('/')
    expect(res.status).toBe(302)
    expect(res.headers.location).toBe('/admin')
  })

  it('GET /admin redirige vers /login sans session et sert la page avec une session', async () => {
    const { app, base } = await setup()
    const anon = await request(app).get('/admin').set('Accept', 'text/html')
    expect(anon.status).toBe(302)
    expect(anon.headers.location).toBe('/login?next=%2Fadmin')
    const ok = await request(app).get('/admin').set('Cookie', base).set('Accept', 'text/html')
    expect(ok.status).toBe(200)
    expect(ok.headers['content-type']).toMatch(/text\/html/)
    expect(ok.text).toContain('Cowork Queue')
    expect(ok.text).not.toContain('/t/')
    expect(ok.text).not.toContain('cdn.tailwindcss.com')
  })

  it('sert les ressources statiques sous /admin/assets', async () => {
    const { app } = makeTestApp()
    const res = await request(app).get('/admin/assets/src.css')
    expect(res.status).toBe(200)
  })
})

describe('authentification avant lecture du corps', () => {
  it('POST non authentifié avec JSON malformé : 401 JSON (pas 400)', async () => {
    const { app } = makeTestApp()
    const res = await request(app)
      .post('/admin/api/messages')
      .set('Content-Type', 'application/json')
      .send('{not json')
    expect(res.status).toBe(401)
    expect(res.body).toMatchObject({ ok: false, error: 'unauthorized' })
    expect(typeof res.body.message).toBe('string')
  })

  it('requête non authentifiée avec Accept: text/html : 401 JSON, jamais de redirection', async () => {
    const { app } = makeTestApp()
    const res = await request(app).get('/admin/api/overview').set('Accept', 'text/html')
    expect(res.status).toBe(401)
    expect(res.headers.location).toBeUndefined()
    expect(res.body.error).toBe('unauthorized')
  })

  it('échec CSRF : 403 JSON avec message, même avec Accept: text/html', async () => {
    const { app, base } = await setup()
    const res = await request(app)
      .patch('/admin/api/settings')
      .set('Cookie', base)
      .set('Accept', 'text/html')
      .send({ ttl_hours: 12 })
    expect(res.status).toBe(403)
    expect(res.body).toMatchObject({ ok: false, error: 'csrf' })
    expect(typeof res.body.message).toBe('string')
  })
})

describe('overview', () => {
  it('renvoie URLs, stats, réglages et jeton CSRF, sans jamais le secret complet', async () => {
    const { app, base, settings } = await setup()
    const res = await request(app).get('/admin/api/overview').set('Cookie', base)
    expect(res.status).toBe(200)
    expect(res.body.version).toBe('0.0.0-test')
    expect(res.body.publicUrl).toBe('https://queue.example.test/')
    expect(res.body.mcpUrl).toBe('https://queue.example.test/mcp')
    expect(res.body.webhookUrl).toBe('https://queue.example.test/webhook')
    expect(res.body.stats).toMatchObject({ total: 0, pending: 0, leased: 0, read_count: 0 })
    expect(res.body.settings.ttl_hours).toBe(48)
    expect(res.body.settings.webhook_secret).toBe('••••gggg')
    expect(JSON.stringify(res.body)).not.toContain(settings.get('webhook_secret'))
    expect(res.body.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(getSetCookie(res, 'cq_csrf')).toBe(res.body.csrfToken)
    expect(res.headers['cache-control']).toBe('no-store')
  })
})

describe('réglages', () => {
  it('PATCH invalide : 400 avec la clé fautive, valeur conservée', async () => {
    const { api, settings } = await setup()
    const res = await api('patch', '/settings').send({ ttl_hours: 0 })
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ ok: false, error: 'invalid_setting', key: 'ttl_hours' })
    expect(typeof res.body.message).toBe('string')
    expect(settings.get('ttl_hours')).toBe(48)
  })

  it('PATCH invalide est tout ou rien', async () => {
    const { api, settings } = await setup()
    const res = await api('patch', '/settings').send({ ttl_hours: 12, cleanup_interval_min: 0 })
    expect(res.status).toBe(400)
    expect(res.body.key).toBe('cleanup_interval_min')
    expect(settings.get('ttl_hours')).toBe(48)
  })

  it('PATCH valide : 200 et valeur appliquée', async () => {
    const { api, settings } = await setup()
    const res = await api('patch', '/settings').send({
      ttl_hours: 24,
      topic_ttl_overrides: { logs: 2 },
    })
    expect(res.status).toBe(200)
    expect(settings.get('ttl_hours')).toBe(24)
    expect(res.body.settings.ttl_hours).toBe(24)
    expect(res.body.settings.topic_ttl_overrides).toEqual({ logs: 2 })
    expect(res.body.settings.webhook_secret).toMatch(/^••••/)
  })

  it('PATCH refuse une clé inconnue et un corps non objet', async () => {
    const { api } = await setup()
    const unknown = await api('patch', '/settings').send({ nope: 1 })
    expect(unknown.status).toBe(400)
    expect(unknown.body.key).toBe('nope')
    const bad = await api('patch', '/settings').send([1])
    expect(bad.status).toBe(400)
  })

  it('GET webhook-secret renvoie le secret en clair', async () => {
    const { api, settings } = await setup()
    const res = await api('get', '/settings/webhook-secret')
    expect(res.status).toBe(200)
    expect(res.body.secret).toBe(settings.get('webhook_secret'))
    expect(res.headers['cache-control']).toBe('no-store')
  })

  it('la rotation invalide l’ancien secret sur POST /webhook et renvoie le nouveau une fois', async () => {
    const { app, api, settings } = await setup()
    const old = settings.get('webhook_secret')
    const before = await request(app).post('/webhook').set('x-webhook-secret', old).send({ a: 1 })
    expect(before.status).toBe(200)

    const res = await api('post', '/settings/webhook-secret/rotate')
    expect(res.status).toBe(200)
    const fresh = res.body.secret as string
    expect(fresh).not.toBe(old)
    expect(fresh.length).toBeGreaterThanOrEqual(32)

    const refused = await request(app).post('/webhook').set('x-webhook-secret', old).send({ a: 2 })
    expect(refused.status).toBe(401)
    const accepted = await request(app)
      .post('/webhook')
      .set('x-webhook-secret', fresh)
      .send({ a: 3 })
    expect(accepted.status).toBe(200)
  })
})

describe('messages', () => {
  it('liste avec pagination et filtre topic, expose statut, bail et tentatives', async () => {
    const { api, repo } = await setup()
    repo.enqueue({ payload: { n: 1 }, source: 'n8n', correlationId: 'a', topic: 'alpha' })
    repo.enqueue({ payload: { n: 2 }, source: 'n8n', correlationId: null, topic: 'beta' })
    repo.enqueue({ payload: { n: 3 }, source: 'n8n', correlationId: null, topic: 'beta' })
    repo.claimNext({ topic: 'alpha', lease: true })

    const all = await api('get', '/messages?limit=2&offset=0')
    expect(all.status).toBe(200)
    expect(all.body.items).toHaveLength(2)
    expect(all.body.total).toBe(3)

    const alpha = await api('get', '/messages?topic=alpha')
    expect(alpha.body.total).toBe(1)
    expect(alpha.body.items[0]).toMatchObject({ topic: 'alpha', status: 'leased', attempts: 1 })

    const bad = await api('get', '/messages?topic=bad%20topic')
    expect(bad.status).toBe(400)
    const byCid = await api('get', '/messages?correlation_id=a')
    expect(byCid.body.items).toHaveLength(1)
    const none = await api('get', '/messages?correlation_id=zzz')
    expect(none.body.items).toEqual([])
  })

  it('POST envoie un message de test (source admin, topic, correlation_id), 409 sur doublon', async () => {
    const { api, repo } = await setup()
    const res = await api('post', '/messages').send({
      payload: { hello: 'x' },
      topic: 'tests',
      correlation_id: 'c-1',
    })
    expect(res.status).toBe(201)
    const item = repo.findByCorrelation('c-1')
    expect(item).toMatchObject({ source: 'admin', topic: 'tests', payload: { hello: 'x' } })
    const dup = await api('post', '/messages').send({ payload: {}, correlation_id: 'c-1' })
    expect(dup.status).toBe(409)
    const badCid = await api('post', '/messages').send({ payload: {}, correlation_id: 'a b' })
    expect(badCid.status).toBe(400)
    const badTopic = await api('post', '/messages').send({ payload: {}, topic: 'a b' })
    expect(badTopic.status).toBe(400)
    const noPayload = await api('post', '/messages').send({})
    expect(noPayload.status).toBe(400)
  })

  it('DELETE /messages/:id supprime, 404 si inconnu', async () => {
    const { api, repo } = await setup()
    const r = repo.enqueue({ payload: {}, source: 'n8n', correlationId: null })
    if (!r.ok) throw new Error('enqueue')
    expect((await api('delete', `/messages/${r.id}`)).status).toBe(200)
    expect((await api('delete', `/messages/${r.id}`)).status).toBe(404)
  })

  it('DELETE /messages exige confirm:true', async () => {
    const { api, repo } = await setup()
    repo.enqueue({ payload: {}, source: 'n8n', correlationId: null })
    expect((await api('delete', '/messages').send({})).status).toBe(400)
    expect(repo.stats().total).toBe(1)
    const res = await api('delete', '/messages').send({ confirm: true })
    expect(res.status).toBe(200)
    expect(res.body.deleted).toBe(1)
    expect(repo.stats().total).toBe(0)
  })
})

describe('clés API', () => {
  it('crée (clé visible une fois), liste sans la clé, révoque', async () => {
    const { api, apiKeys } = await setup()
    const created = await api('post', '/api-keys').send({ name: 'Claude' })
    expect(created.status).toBe(201)
    expect(created.body.key).toMatch(/^cwk_[A-Za-z0-9]{32}$/)
    expect(apiKeys.verify(created.body.key)).not.toBeNull()

    const list = await api('get', '/api-keys')
    expect(list.body.keys).toHaveLength(1)
    expect(list.body.keys[0]).toMatchObject({
      name: 'Claude',
      prefix: created.body.prefix,
      revoked: false,
    })
    expect(JSON.stringify(list.body)).not.toContain(created.body.key)

    expect((await api('delete', `/api-keys/${created.body.id}`)).status).toBe(200)
    expect(apiKeys.verify(created.body.key)).toBeNull()
    expect((await api('delete', `/api-keys/${created.body.id}`)).status).toBe(404)
    expect((await api('delete', '/api-keys/abc')).status).toBe(400)
  })

  it('refuse un nom invalide', async () => {
    const { api } = await setup()
    const res = await api('post', '/api-keys').send({ name: '   ' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_name')
  })
})

describe('clients OAuth', () => {
  it('liste puis supprime un client et, en cascade, ses jetons', async () => {
    const { api, db, oauthProvider } = await setup()
    const client = oauthProvider.clientsStore.registerClient({
      redirect_uris: ['https://claude.ai/cb'],
      client_name: 'Claude',
    })
    db.prepare(
      `INSERT INTO oauth_tokens (token_hash, kind, client_id, user_id, scopes, expires_at, created_at)
       VALUES ('h1', 'access', ?, 1, 'queue', 9999999999999, 1)`,
    ).run(client.client_id)

    const list = await api('get', '/oauth-clients')
    expect(list.status).toBe(200)
    expect(list.body.clients).toHaveLength(1)
    expect(list.body.clients[0]).toMatchObject({
      client_id: client.client_id,
      client_name: 'Claude',
    })

    expect((await api('delete', `/oauth-clients/${client.client_id}`)).status).toBe(200)
    expect(db.prepare('SELECT COUNT(*) AS n FROM oauth_tokens').get()).toEqual({ n: 0 })
    expect((await api('delete', `/oauth-clients/${client.client_id}`)).status).toBe(404)
  })
})

describe('compte et maintenance', () => {
  it('change le mot de passe : ancien requis, ≥ 12 car., autres sessions invalidées', async () => {
    const { api, users, sessions, session, user } = await setup()
    const other = sessions.create(user.id)

    const wrong = await api('post', '/password').send({
      current: 'faux',
      next: 'nouveau-mot-de-passe-2',
    })
    expect(wrong.status).toBe(400)
    expect(wrong.body.error).toBe('invalid_password')

    const short = await api('post', '/password').send({ current: PASSWORD, next: 'court' })
    expect(short.status).toBe(400)
    expect(short.body.error).toBe('invalid_password')

    const ok = await api('post', '/password').send({
      current: PASSWORD,
      next: 'nouveau-mot-de-passe-2',
    })
    expect(ok.status).toBe(200)
    expect(await users.verify(EMAIL, 'nouveau-mot-de-passe-2')).not.toBeNull()
    expect(await users.verify(EMAIL, PASSWORD)).toBeNull()
    expect(sessions.resolve(session)).not.toBeNull()
    expect(sessions.resolve(other)).toBeNull()
  })

  it('VACUUM s’exécute', async () => {
    const { api } = await setup()
    const res = await api('post', '/maintenance/vacuum')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })
})

describe('version et mise à jour', () => {
  const SECRET = 'u'.repeat(32)
  const versions = {
    current: '2.0.0',
    check: async () => ({
      current: '2.0.0',
      latest: '2.1.0',
      updateAvailable: true,
      notes: 'Nouveautés',
      url: 'https://github.com/x/y/releases/tag/v2.1.0',
    }),
  }

  it('GET /version exige une session', async () => {
    const { app } = makeTestApp()
    expect((await request(app).get('/admin/api/version')).status).toBe(401)
  })

  it('GET /version renvoie l’état de la vérification et la présence de l’updater', async () => {
    const { api } = await setupWith({ versions })
    const res = await api('get', '/version')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      ok: true,
      current: '2.0.0',
      latest: '2.1.0',
      updateAvailable: true,
      notes: 'Nouveautés',
      url: 'https://github.com/x/y/releases/tag/v2.1.0',
      updater: false,
    })
  })

  it('POST /update sans updater : 409 no_updater avec la commande', async () => {
    const { api } = await setupWith({ versions })
    const res = await api('post', '/update').send({})
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ ok: false, error: 'no_updater', command: './update.sh' })
    expect(typeof res.body.message).toBe('string')
  })

  it('POST /update exige le jeton CSRF', async () => {
    const { app, base } = await setupWith({ versions })
    expect((await request(app).post('/admin/api/update').set('Cookie', base).send({})).status).toBe(
      403,
    )
  })

  it('POST /update avec updater : relaie vers <url>/update avec le secret et répond 202', async () => {
    const updaterFetch = vi.fn<typeof fetch>(async () => new Response('{}', { status: 202 }))
    const { api } = await setupWith({
      versions,
      updaterFetch,
      env: testEnv({ updater: { url: new URL('http://updater:8081'), secret: SECRET } }),
    })
    const res = await api('post', '/update').send({})
    expect(res.status).toBe(202)
    expect(res.body).toEqual({ ok: true, started: true })
    const [url, init] = updaterFetch.mock.calls[0]!
    expect(String(url)).toBe('http://updater:8081/update')
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('x-updater-secret')).toBe(SECRET)
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    const ver = await api('get', '/version')
    expect(ver.body.updater).toBe(true)
  })

  it('POST /update : mappe les réponses de l’updater', async () => {
    const env = testEnv({ updater: { url: new URL('http://updater:8081'), secret: SECRET } })
    const call = async (updaterFetch: typeof fetch) => {
      const ctx = await setupWith({ versions, env, updaterFetch })
      return ctx.api('post', '/update').send({})
    }
    const down = await call(async () => {
      throw new Error('ECONNREFUSED')
    })
    expect(down.status).toBe(502)
    expect(down.body).toMatchObject({ ok: false, error: 'updater_unreachable' })
    expect(JSON.stringify(down.body)).not.toContain(SECRET)

    const busy = await call(async () => new Response('{}', { status: 409 }))
    expect(busy.status).toBe(409)
    expect(busy.body).toMatchObject({ ok: false, error: 'update_running' })

    const bad = await call(async () => new Response('{}', { status: 401 }))
    expect(bad.status).toBe(502)
    expect(bad.body).toMatchObject({ ok: false, error: 'updater_misconfigured' })

    const other = await call(async () => new Response('{}', { status: 500 }))
    expect(other.status).toBe(502)
    expect(other.body.error).toBe('updater_unreachable')
  })
})
