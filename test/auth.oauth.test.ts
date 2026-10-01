import { createHash } from 'node:crypto'
import express, { type Express } from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createBearerMiddleware, mcpResourceMetadataUrl } from '../src/auth/bearer.js'
import { SqliteOAuthProvider } from '../src/auth/oauth/provider.js'
import { SESSION_COOKIE } from '../src/auth/sessions.js'
import { randomToken, sha256 } from '../src/auth/tokens.js'
import { startCleanup } from '../src/jobs/cleanup.js'
import { getSetCookie, makeAppDeps, makeTestApp, testEnv } from './helpers/app.js'

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback'
const PRM_URL = 'https://queue.example.test/.well-known/oauth-protected-resource/mcp'

/** Horloge injectée : décalage ajustable par test (la base reste proche de l'heure réelle). */
let offset = 0
const now = () => Date.now() + offset

let t: ReturnType<typeof makeTestApp> & { oauthProvider: SqliteOAuthProvider }

function pkce() {
  const verifier = randomToken(32)
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

beforeEach(() => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  offset = 0
  const base = makeAppDeps()
  const oauthProvider = new SqliteOAuthProvider({
    db: base.db,
    sessions: base.sessions,
    env: base.env,
    now,
  })
  t = makeTestApp({ ...base, oauthProvider }) as typeof t
})

async function register(app: Express, over: Record<string, unknown> = {}) {
  return request(app)
    .post('/register')
    .send({
      redirect_uris: [REDIRECT],
      client_name: 'Claude <b>connecteur</b>',
      token_endpoint_auth_method: 'none',
      ...over,
    })
}

async function registerClient(app: Express = t.app): Promise<string> {
  const res = await register(app)
  expect(res.status).toBe(201)
  return res.body.client_id as string
}

async function adminCookie(): Promise<string> {
  const user = await t.users.create('admin@example.test', 'correct horse battery')
  return `${SESSION_COOKIE}=${t.sessions.create(user.id)}`
}

function authorizeQuery(clientId: string, challenge: string, over: Record<string, string> = {}) {
  return {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'etat-123',
    ...over,
  }
}

/** /authorize avec session → page de consentement : renvoie l'id de requête, le CSRF et la page. */
async function openConsent(cookie: string, query: Record<string, string>) {
  const a = await request(t.app).get('/authorize').query(query).set('Cookie', cookie)
  expect(a.status).toBe(302)
  const loc = a.headers.location as string
  expect(loc).toMatch(/^\/oauth\/consent\?req=[A-Za-z0-9_-]+$/)
  const page = await request(t.app).get(loc).set('Cookie', cookie).set('Accept', 'text/html')
  expect(page.status).toBe(200)
  const csrf = getSetCookie(page, 'inbox_csrf')!
  const req = /name="req" value="([^"]+)"/.exec(page.text)?.[1]
  expect(req).toBeTruthy()
  return { page, csrf, req: req! }
}

async function decide(cookie: string, c: { csrf: string; req: string }, decision: string) {
  return request(t.app)
    .post('/oauth/consent')
    .set('Accept', 'text/html')
    .set('Cookie', [cookie, `inbox_csrf=${c.csrf}`].filter(Boolean).join('; '))
    .type('form')
    .send({ _csrf: c.csrf, req: c.req, decision })
}

/** Flux complet jusqu'au code d'autorisation. */
async function obtainCode(clientId: string, challenge: string, cookie?: string) {
  cookie ??= await adminCookie()
  const c = await openConsent(cookie, authorizeQuery(clientId, challenge))
  const res = await decide(cookie, c, 'allow')
  expect(res.status).toBe(302)
  const url = new URL(res.headers.location as string)
  expect(`${url.origin}${url.pathname}`).toBe(REDIRECT)
  expect(url.searchParams.get('state')).toBe('etat-123')
  return url.searchParams.get('code')!
}

async function exchangeCode(clientId: string, code: string, verifier: string, over = {}) {
  return request(t.app)
    .post('/token')
    .type('form')
    .send({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      ...over,
    })
}

async function refresh(clientId: string, refreshToken: string) {
  return request(t.app)
    .post('/token')
    .type('form')
    .send({ grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken })
}

async function fullTokens() {
  const clientId = await registerClient()
  const { verifier, challenge } = pkce()
  const code = await obtainCode(clientId, challenge)
  const res = await exchangeCode(clientId, code, verifier)
  expect(res.status).toBe(200)
  return { clientId, tokens: res.body as Record<string, unknown> }
}

describe('métadonnées OAuth', () => {
  it('GET /.well-known/oauth-authorization-server → issuer = PUBLIC_URL, S256', async () => {
    const res = await request(t.app).get('/.well-known/oauth-authorization-server')
    expect(res.status).toBe(200)
    expect(res.body.issuer).toBe('https://queue.example.test/')
    expect(res.body.code_challenge_methods_supported).toContain('S256')
    expect(res.body.authorization_endpoint).toBe('https://queue.example.test/authorize')
    expect(res.body.token_endpoint).toBe('https://queue.example.test/token')
    expect(res.body.registration_endpoint).toBe('https://queue.example.test/register')
    expect(res.body.revocation_endpoint).toBe('https://queue.example.test/revoke')
    expect(res.body.scopes_supported).toEqual(['queue'])
  })

  it('GET /.well-known/oauth-protected-resource/mcp → resource = <PUBLIC_URL>mcp', async () => {
    const res = await request(t.app).get('/.well-known/oauth-protected-resource/mcp')
    expect(res.status).toBe(200)
    expect(res.body.resource).toBe('https://queue.example.test/mcp')
    expect(res.body.authorization_servers).toEqual(['https://queue.example.test/'])
    expect(res.body.resource_name).toBe('Agent Inbox')
  })

  it('mcpResourceMetadataUrl pointe vers la ressource /mcp', () => {
    expect(mcpResourceMetadataUrl(testEnv())).toBe(PRM_URL)
  })
})

describe('POST /register (DCR)', () => {
  it('renvoie un client_id aléatoire et le persiste', async () => {
    const res = await register(t.app)
    expect(res.status).toBe(201)
    expect(res.body.client_id).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(res.body.redirect_uris).toEqual([REDIRECT])
    const stored = await t.oauthProvider.clientsStore.getClient(res.body.client_id)
    expect(stored?.client_name).toBe('Claude <b>connecteur</b>')
  })

  it('accepte les redirections loopback http (clients natifs / CLI)', async () => {
    for (const uri of ['http://localhost:53682/callback', 'http://127.0.0.1:8976/cb']) {
      const res = await register(t.app, { redirect_uris: [uri] })
      expect(res.status, uri).toBe(201)
    }
  })

  it('refuse les redirections non https hors loopback → invalid_redirect_uri', async () => {
    for (const uri of [
      'http://evil.example/cb',
      'javascript:alert(1)',
      'myapp://callback',
      'http://localhost.evil.example/cb',
    ]) {
      const res = await register(t.app, { redirect_uris: [uri] })
      expect(res.status, uri).toBe(400)
      expect(res.body.error, uri).toMatch(/^invalid_(redirect_uri|client_metadata)$/)
    }
    const mixed = await register(t.app, { redirect_uris: [REDIRECT, 'http://evil.example/cb'] })
    expect(mixed.status).toBe(400)
    expect(mixed.body.error).toBe('invalid_redirect_uri')
  })

  it('rate limit : 10 requêtes/min/IP', async () => {
    for (let i = 0; i < 10; i++) expect((await register(t.app)).status).toBe(201)
    expect((await register(t.app)).status).toBe(429)
  })
})

describe('GET /authorize', () => {
  it('sans session → 302 /login?next=/oauth/consent?req=…', async () => {
    const clientId = await registerClient()
    const res = await request(t.app)
      .get('/authorize')
      .query(authorizeQuery(clientId, pkce().challenge))
    expect(res.status).toBe(302)
    const loc = new URL(res.headers.location as string, 'https://x.test')
    expect(loc.pathname).toBe('/login')
    expect(loc.searchParams.get('next')).toMatch(/^\/oauth\/consent\?req=[A-Za-z0-9_-]+$/)
  })

  it('avec session → page de consentement (nom échappé, hôte de redirection, CSP)', async () => {
    const clientId = await registerClient()
    const cookie = await adminCookie()
    const { page } = await openConsent(cookie, authorizeQuery(clientId, pkce().challenge))
    expect(page.text).toContain('Claude &lt;b&gt;connecteur&lt;/b&gt;')
    expect(page.text).not.toContain('<b>connecteur')
    expect(page.text).toContain('claude.ai')
    expect(page.text).toContain('Autoriser')
    expect(page.text).toContain('Refuser')
    const csp = page.headers['content-security-policy'] as string
    expect(csp).toContain("form-action 'self' https://claude.ai")
    expect(csp).toContain("frame-ancestors 'none'")
  })

  it('après connexion, /login renvoie vers la page de consentement', async () => {
    const clientId = await registerClient()
    const a = await request(t.app)
      .get('/authorize')
      .query(authorizeQuery(clientId, pkce().challenge))
    const next = new URL(a.headers.location as string, 'https://x.test').searchParams.get('next')!
    const cookie = await adminCookie()
    const login = await request(t.app)
      .get('/login')
      .query({ next })
      .set('Cookie', cookie)
      .set('Accept', 'text/html')
    expect(login.status).toBe(302)
    expect(login.headers.location).toBe(next)
  })

  it('redirect_uri non enregistrée → 400 sans redirection', async () => {
    const clientId = await registerClient()
    const res = await request(t.app)
      .get('/authorize')
      .query(
        authorizeQuery(clientId, pkce().challenge, { redirect_uri: 'https://evil.example/cb' }),
      )
    expect(res.status).toBe(400)
    expect(res.headers.location).toBeUndefined()
    expect(res.body.error).toBe('invalid_request')
  })

  it('client inconnu → 400 sans redirection', async () => {
    const res = await request(t.app)
      .get('/authorize')
      .query(authorizeQuery('inconnu', pkce().challenge))
    expect(res.status).toBe(400)
    expect(res.headers.location).toBeUndefined()
  })

  it('sans code_challenge → erreur renvoyée à la redirect_uri enregistrée, sans code', async () => {
    const clientId = await registerClient()
    const query: Record<string, string> = authorizeQuery(clientId, 'x')
    delete query.code_challenge
    const res = await request(t.app).get('/authorize').query(query)
    expect(res.status).toBe(302)
    const loc = new URL(res.headers.location as string)
    expect(`${loc.origin}${loc.pathname}`).toBe(REDIRECT)
    expect(loc.searchParams.get('error')).toBe('invalid_request')
    expect(loc.searchParams.get('code')).toBeNull()
  })

  it('code_challenge_method=plain → erreur', async () => {
    const clientId = await registerClient()
    const res = await request(t.app)
      .get('/authorize')
      .query(authorizeQuery(clientId, pkce().challenge, { code_challenge_method: 'plain' }))
    expect(new URL(res.headers.location as string).searchParams.get('error')).toBe(
      'invalid_request',
    )
  })

  it('scope inconnu → invalid_scope', async () => {
    const clientId = await registerClient()
    const res = await request(t.app)
      .get('/authorize')
      .query(authorizeQuery(clientId, pkce().challenge, { scope: 'queue admin' }))
    const loc = new URL(res.headers.location as string)
    expect(loc.searchParams.get('error')).toBe('invalid_scope')
    expect(loc.searchParams.get('state')).toBe('etat-123')
  })
})

describe('POST /oauth/consent', () => {
  it('Refuser → 302 redirect_uri?error=access_denied&state', async () => {
    const clientId = await registerClient()
    const cookie = await adminCookie()
    const c = await openConsent(cookie, authorizeQuery(clientId, pkce().challenge))
    const res = await decide(cookie, c, 'deny')
    expect(res.status).toBe(302)
    const loc = new URL(res.headers.location as string)
    expect(`${loc.origin}${loc.pathname}`).toBe(REDIRECT)
    expect(loc.searchParams.get('error')).toBe('access_denied')
    expect(loc.searchParams.get('state')).toBe('etat-123')
    expect(loc.searchParams.get('code')).toBeNull()
  })

  it('sans CSRF → 403, aucun code émis', async () => {
    const clientId = await registerClient()
    const cookie = await adminCookie()
    const c = await openConsent(cookie, authorizeQuery(clientId, pkce().challenge))
    const res = await request(t.app)
      .post('/oauth/consent')
      .set('Accept', 'text/html')
      .set('Cookie', cookie)
      .type('form')
      .send({ req: c.req, decision: 'allow' })
    expect(res.status).toBe(403)
    expect(res.headers.location).toBeUndefined()
  })

  it('req absent, mal formé ou inconnu → 400 immédiat, avec ou sans session', async () => {
    const cookie = await adminCookie()
    for (const path of [
      '/oauth/consent',
      '/oauth/consent?req=../../evil',
      `/oauth/consent?req=${randomToken(16)}`,
    ]) {
      for (const c of ['', cookie]) {
        const r = request(t.app).get(path).set('Accept', 'text/html')
        const res = await (c ? r.set('Cookie', c) : r)
        expect(res.status, `${path} session=${Boolean(c)}`).toBe(400)
        expect(res.headers.location).toBeUndefined()
      }
    }
  })

  it('req valide sans session → /login puis retour au consentement', async () => {
    const clientId = await registerClient()
    const cookie = await adminCookie()
    const c = await openConsent(cookie, authorizeQuery(clientId, pkce().challenge))
    const res = await request(t.app).get(`/oauth/consent?req=${c.req}`).set('Accept', 'text/html')
    expect(res.status).toBe(302)
    expect(res.headers.location).toBe(
      `/login?next=${encodeURIComponent(`/oauth/consent?req=${c.req}`)}`,
    )
  })

  it('sans session → pas de code (redirection vers /login)', async () => {
    const clientId = await registerClient()
    const cookie = await adminCookie()
    const c = await openConsent(cookie, authorizeQuery(clientId, pkce().challenge))
    const res = await decide('', c, 'allow')
    expect(res.status).toBe(302)
    expect(res.headers.location).toMatch(/^\/login\?next=/)
  })

  it('requête de consentement à usage unique et expirant après 10 min', async () => {
    const clientId = await registerClient()
    const cookie = await adminCookie()
    const c = await openConsent(cookie, authorizeQuery(clientId, pkce().challenge))
    expect((await decide(cookie, c, 'allow')).status).toBe(302)
    const again = await decide(cookie, c, 'allow')
    expect(again.status).toBe(400)
    expect(again.headers.location).toBeUndefined()

    const c2 = await openConsent(cookie, authorizeQuery(clientId, pkce().challenge))
    offset = 10 * 60_000
    const late = await decide(cookie, c2, 'allow')
    expect(late.status).toBe(400)
    expect(late.headers.location).toBeUndefined()
  })
})

describe('POST /token', () => {
  it('code + bon code_verifier → access_token, refresh_token, expires_in 3600', async () => {
    const { tokens } = await fullTokens()
    expect(tokens.access_token).toEqual(expect.any(String))
    expect(tokens.refresh_token).toEqual(expect.any(String))
    expect(tokens.token_type).toBe('Bearer')
    expect(tokens.expires_in).toBe(3600)
    expect(tokens.scope).toBe('queue')
  })

  it('ne stocke que des empreintes SHA-256', async () => {
    const { tokens } = await fullTokens()
    const rows = t.db.prepare('SELECT token_hash, kind FROM oauth_tokens').all() as {
      token_hash: string
      kind: string
    }[]
    expect(rows.map((r) => r.token_hash).sort()).toEqual(
      [sha256(tokens.access_token as string), sha256(tokens.refresh_token as string)].sort(),
    )
    const dump = JSON.stringify(t.db.prepare('SELECT * FROM oauth_tokens').all())
    expect(dump).not.toContain(tokens.access_token as string)
  })

  it('mauvais code_verifier → invalid_grant', async () => {
    const clientId = await registerClient()
    const { challenge } = pkce()
    const code = await obtainCode(clientId, challenge)
    const res = await exchangeCode(clientId, code, pkce().verifier)
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_grant')
  })

  it('code réutilisé → invalid_grant', async () => {
    const clientId = await registerClient()
    const { verifier, challenge } = pkce()
    const code = await obtainCode(clientId, challenge)
    expect((await exchangeCode(clientId, code, verifier)).status).toBe(200)
    const again = await exchangeCode(clientId, code, verifier)
    expect(again.status).toBe(400)
    expect(again.body.error).toBe('invalid_grant')
  })

  it('code expiré (10 min) → invalid_grant', async () => {
    const clientId = await registerClient()
    const { verifier, challenge } = pkce()
    const code = await obtainCode(clientId, challenge)
    offset = 10 * 60_000
    const res = await exchangeCode(clientId, code, verifier)
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_grant')
  })

  it('code présenté par un autre client → invalid_grant', async () => {
    const clientId = await registerClient()
    const other = await registerClient()
    const { verifier, challenge } = pkce()
    const code = await obtainCode(clientId, challenge)
    const res = await exchangeCode(other, code, verifier)
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_grant')
  })

  it('redirect_uri différente de celle du code → invalid_grant', async () => {
    const res0 = await register(t.app, {
      redirect_uris: [REDIRECT, 'https://claude.ai/autre'],
    })
    const clientId = res0.body.client_id as string
    const { verifier, challenge } = pkce()
    const code = await obtainCode(clientId, challenge)
    const res = await exchangeCode(clientId, code, verifier, {
      redirect_uri: 'https://claude.ai/autre',
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_grant')
  })

  it('refresh → nouvelle paire ; ancien refresh réutilisé → invalid_grant et famille révoquée', async () => {
    const { clientId, tokens } = await fullTokens()
    const r1 = await refresh(clientId, tokens.refresh_token as string)
    expect(r1.status).toBe(200)
    expect(r1.body.access_token).not.toBe(tokens.access_token)
    expect(r1.body.refresh_token).not.toBe(tokens.refresh_token)
    expect(r1.body.expires_in).toBe(3600)

    const reuse = await refresh(clientId, tokens.refresh_token as string)
    expect(reuse.status).toBe(400)
    expect(reuse.body.error).toBe('invalid_grant')

    // Détection de réutilisation : la nouvelle paire est révoquée elle aussi.
    await expect(t.oauthProvider.verifyAccessToken(r1.body.access_token)).rejects.toThrow()
    const r2 = await refresh(clientId, r1.body.refresh_token as string)
    expect(r2.body.error).toBe('invalid_grant')
  })

  it('après un nettoyage, rejouer l’ancien refresh → invalid_grant et famille révoquée', async () => {
    const { clientId, tokens } = await fullTokens()
    const r1 = await refresh(clientId, tokens.refresh_token as string)
    expect(r1.status).toBe(200)

    const job = startCleanup({ db: t.db, repo: t.repo, settings: t.settings, now, log: () => {} })
    job.runOnce()
    job.stop()

    const reuse = await refresh(clientId, tokens.refresh_token as string)
    expect(reuse.status).toBe(400)
    expect(reuse.body.error).toBe('invalid_grant')
    await expect(t.oauthProvider.verifyAccessToken(r1.body.access_token)).rejects.toThrow()
    expect((await refresh(clientId, r1.body.refresh_token as string)).body.error).toBe(
      'invalid_grant',
    )
  })

  it('refresh expiré (30 j) → invalid_grant', async () => {
    const { clientId, tokens } = await fullTokens()
    offset = 30 * 24 * 3600_000
    const res = await refresh(clientId, tokens.refresh_token as string)
    expect(res.body.error).toBe('invalid_grant')
  })

  it('rate limit : 10 requêtes/min/IP', async () => {
    const clientId = await registerClient()
    for (let i = 0; i < 10; i++) {
      expect((await refresh(clientId, 'inconnu')).status).toBe(400)
    }
    expect((await refresh(clientId, 'inconnu')).status).toBe(429)
  })
})

describe('middleware Bearer', () => {
  let probe: Express

  beforeEach(() => {
    probe = express()
    probe.get(
      '/probe',
      createBearerMiddleware({
        provider: t.oauthProvider,
        apiKeys: t.apiKeys,
        resourceMetadataUrl: PRM_URL,
      }),
      (req, res) => {
        res.json({ clientId: req.auth?.clientId, scopes: req.auth?.scopes })
      },
    )
  })

  const call = (auth?: string) => {
    const r = request(probe).get('/probe')
    return auth ? r.set('Authorization', auth) : r
  }

  const expect401 = (res: request.Response) => {
    expect(res.status).toBe(401)
    expect(res.headers['www-authenticate']).toContain('Bearer')
    expect(res.headers['www-authenticate']).toContain(`resource_metadata="${PRM_URL}"`)
  }

  it('access token valide → next() avec req.auth', async () => {
    const { clientId, tokens } = await fullTokens()
    const res = await call(`Bearer ${tokens.access_token as string}`)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ clientId, scopes: ['queue'] })
  })

  it('sans en-tête → 401 + WWW-Authenticate resource_metadata', async () => {
    expect401(await call())
  })

  it('jeton inconnu → 401', async () => {
    expect401(await call(`Bearer ${randomToken(32)}`))
  })

  it('access token expiré (horloge +2 h) → 401', async () => {
    const { tokens } = await fullTokens()
    offset = 2 * 3600_000
    expect401(await call(`Bearer ${tokens.access_token as string}`))
  })

  it('access token révoqué via /revoke → 401', async () => {
    const { clientId, tokens } = await fullTokens()
    const rev = await request(t.app)
      .post('/revoke')
      .type('form')
      .send({ client_id: clientId, token: tokens.access_token })
    expect(rev.status).toBe(200)
    expect401(await call(`Bearer ${tokens.access_token as string}`))
  })

  it('refresh token utilisé comme access token → 401', async () => {
    const { tokens } = await fullTokens()
    expect401(await call(`Bearer ${tokens.refresh_token as string}`))
  })

  it('clé API valide → next() avec clientId api-key:<id>', async () => {
    const { id, key } = t.apiKeys.create('n8n')
    const res = await call(`Bearer ${key}`)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ clientId: `api-key:${id}`, scopes: ['queue'] })
  })

  it('jeton OAuth commençant par aik_ → authentifié par le vérificateur OAuth', async () => {
    const clientId = await registerClient()
    const token = `aik_${randomToken(32).slice(4)}`
    t.db
      .prepare(
        `INSERT INTO oauth_tokens (token_hash, kind, client_id, user_id, scopes, resource, expires_at, created_at)
         VALUES (?, 'access', ?, 1, 'queue', NULL, ?, ?)`,
      )
      .run(sha256(token), clientId, now() + 3600_000, now())
    const res = await call(`Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ clientId, scopes: ['queue'] })
  })

  it('clé API révoquée → 401 + WWW-Authenticate', async () => {
    const { id, key } = t.apiKeys.create('n8n')
    t.apiKeys.revoke(id)
    expect401(await call(`Bearer ${key}`))
  })
})

describe('CSP des pages', () => {
  it("toutes les pages portent form-action 'self'", async () => {
    const res = await request(t.app).get('/login').set('Accept', 'text/html')
    expect(res.headers['content-security-policy']).toContain("form-action 'self'")
  })
})
