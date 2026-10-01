import cookieParser from 'cookie-parser'
import express, { type Express } from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { requireAdminSession, createAdminSessions } from '../src/auth/sessions.js'
import { getSetCookie, makeTestApp, setCookieLines, testEnv } from './helpers/app.js'

const PW = 'correct horse battery'
const CODE = 'ABCD-EFGH-JKLM-NPQR-STUV-WXYZ'

let t: ReturnType<typeof makeTestApp>

beforeEach(() => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  t = makeTestApp({ setupCode: { value: CODE } })
})

/** GET d'une page : renvoie le cookie cq_csrf et le jeton du champ caché. */
async function csrfFrom(app: Express, path: string) {
  const res = await request(app).get(path).set('Accept', 'text/html')
  const cookie = getSetCookie(res, 'cq_csrf')
  const field = /name="_csrf" value="([^"]+)"/.exec(res.text)?.[1]
  expect(cookie).toBeTruthy()
  expect(field).toBe(cookie)
  return { cookie: `cq_csrf=${cookie}`, token: field! }
}

async function postForm(
  app: Express,
  path: string,
  fields: Record<string, string>,
  extraCookie = '',
) {
  const { cookie, token } = await csrfFrom(app, path === '/setup' ? '/setup' : '/login')
  return request(app)
    .post(path)
    .set('Accept', 'text/html')
    .set('Cookie', [cookie, extraCookie].filter(Boolean).join('; '))
    .type('form')
    .send({ _csrf: token, ...fields })
}

const setupFields = (code = CODE) => ({ code, email: 'admin@example.com', password: PW })

describe('/setup', () => {
  it('GET affiche le formulaire tant qu’aucun compte n’existe', async () => {
    const r = await request(app()).get('/setup')
    expect(r.status).toBe(200)
    expect(r.headers['content-type']).toMatch(/text\/html/)
    expect(r.text).toContain('<label for="code"')
    const line = setCookieLines(r, 'cq_csrf')[0]!
    expect(line).toMatch(/HttpOnly/i)
    expect(line).toMatch(/SameSite=Strict/i)
    expect(line).toMatch(/Secure/i)
  })

  it('sans code → 403, aucun compte créé', async () => {
    const r = await postForm(app(), '/setup', { email: 'admin@example.com', password: PW })
    expect(r.status).toBe(403)
    expect(t.users.count()).toBe(0)
    expect(t.setupCode.value).toBe(CODE)
  })

  it('mauvais code → 403', async () => {
    const r = await postForm(app(), '/setup', setupFields('ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ'))
    expect(r.status).toBe(403)
    expect(t.users.count()).toBe(0)
  })

  it('mot de passe < 12 caractères → 400, code conservé', async () => {
    const r = await postForm(app(), '/setup', { ...setupFields(), password: 'court' })
    expect(r.status).toBe(400)
    expect(r.text).toContain('12 caractères')
    expect(t.users.count()).toBe(0)
    expect(t.setupCode.value).toBe(CODE)
  })

  it('avec code → compte créé, cookie de session posé, code invalidé ; second setup → 404', async () => {
    const r = await postForm(app(), '/setup', setupFields(CODE.toLowerCase()))
    expect(r.status).toBe(302)
    expect(r.headers.location).toBe('/admin')
    expect(t.users.count()).toBe(1)
    expect(t.setupCode.value).toBeNull()
    const line = setCookieLines(r, 'cq_session')[0]!
    expect(line).toMatch(/HttpOnly/i)
    expect(line).toMatch(/Secure/i)
    expect(line).toMatch(/SameSite=Lax/i)
    expect(line).toMatch(/Path=\//)
    expect(line).toMatch(/Max-Age=604800/)
    const session = getSetCookie(r, 'cq_session')!
    expect(t.sessions.resolve(session)).toMatchObject({ email: 'admin@example.com' })

    expect((await request(app()).get('/setup')).status).toBe(404)
    const again = await request(app()).post('/setup').type('form').send(setupFields())
    expect(again.status).toBe(404)
  })

  it('404 dès qu’un utilisateur existe, même avec un code en mémoire', async () => {
    await t.users.create('a@example.com', PW)
    expect((await request(app()).get('/setup')).status).toBe(404)
  })

  it('POST sans jeton CSRF → 403', async () => {
    const r = await request(app()).post('/setup').type('form').send(setupFields())
    expect(r.status).toBe(403)
    expect(t.users.count()).toBe(0)
  })

  it('POST avec un jeton CSRF qui ne correspond pas au cookie → 403', async () => {
    const { cookie } = await csrfFrom(app(), '/setup')
    const r = await request(app())
      .post('/setup')
      .set('Cookie', cookie)
      .type('form')
      .send({ _csrf: 'x'.repeat(43), ...setupFields() })
    expect(r.status).toBe(403)
    expect(t.users.count()).toBe(0)
  })
})

describe('/login', () => {
  beforeEach(async () => {
    t.setupCode.value = null
    await t.users.create('admin@example.com', PW)
  })

  it('mauvais mot de passe → 401 avec message générique', async () => {
    const r = await postForm(app(), '/login', {
      email: 'admin@example.com',
      password: 'faux faux faux',
    })
    expect(r.status).toBe(401)
    expect(r.text).toContain('Email ou mot de passe incorrect')
    expect(setCookieLines(r, 'cq_session')).toHaveLength(0)
    const r2 = await postForm(app(), '/login', { email: 'nobody@example.com', password: PW })
    expect(r2.status).toBe(401)
    expect(r2.text).toContain('Email ou mot de passe incorrect')
  })

  it('les valeurs réaffichées sont échappées', async () => {
    const r = await postForm(app(), '/login', {
      email: '"><script>alert(1)</script>',
      password: 'x',
      next: '/"><b>',
    })
    expect(r.text).not.toContain('<script>alert(1)')
    expect(r.text).toContain('&quot;&gt;&lt;script&gt;')
    expect(r.text).not.toContain('<b>')
  })

  it('succès → 302 vers next relatif + cookie de session', async () => {
    const r = await postForm(app(), '/login', {
      email: 'ADMIN@example.com',
      password: PW,
      next: '/authorize?client_id=abc&state=x',
    })
    expect(r.status).toBe(302)
    expect(r.headers.location).toBe('/authorize?client_id=abc&state=x')
    expect(t.sessions.resolve(getSetCookie(r, 'cq_session'))).not.toBeNull()
  })

  it.each(['//evil.com', '/\\evil.com', 'https://evil.com', '/\t/evil.com', ''])(
    'next=%j non sûr → /admin',
    async (next) => {
      const r = await postForm(app(), '/login', { email: 'admin@example.com', password: PW, next })
      expect(r.status).toBe(302)
      expect(r.headers.location).toBe('/admin')
    },
  )

  it('GET /login?next=… reporte next dans le formulaire (échappé)', async () => {
    const r = await request(app()).get('/login?next=%2Fauthorize%3Fa%3D1%26b%3D2')
    expect(r.status).toBe(200)
    expect(r.text).toContain('name="next" value="/authorize?a=1&amp;b=2"')
  })

  it('GET /login avec une session valide → redirige vers next', async () => {
    const session = t.sessions.create(1)
    const r = await request(app())
      .get('/login?next=%2Fadmin%2Fkeys')
      .set('Cookie', `cq_session=${session}`)
    expect(r.status).toBe(302)
    expect(r.headers.location).toBe('/admin/keys')
  })

  it('rate limit : 429 à la 11e tentative', async () => {
    const a = app()
    const { cookie, token } = await csrfFrom(a, '/login')
    const attempt = () =>
      request(a)
        .post('/login')
        .set('Cookie', cookie)
        .type('form')
        .send({ _csrf: token, email: 'admin@example.com', password: 'faux faux faux' })
    for (let i = 0; i < 10; i++) expect((await attempt()).status).toBe(401)
    const r = await attempt()
    expect(r.status).toBe(429)
    expect(r.text).toContain('Trop de tentatives')
  })

  it('POST sans jeton CSRF → 403', async () => {
    const r = await request(app())
      .post('/login')
      .type('form')
      .send({ email: 'admin@example.com', password: PW })
    expect(r.status).toBe(403)
    expect(setCookieLines(r, 'cq_session')).toHaveLength(0)
  })
})

describe('/logout', () => {
  it('détruit la session et efface le cookie', async () => {
    await t.users.create('admin@example.com', PW)
    const session = t.sessions.create(1)
    const r = await postForm(app(), '/logout', {}, `cq_session=${session}`)
    expect(r.status).toBe(302)
    expect(r.headers.location).toBe('/login')
    expect(t.sessions.resolve(session)).toBeNull()
    expect(setCookieLines(r, 'cq_session')[0]).toMatch(/cq_session=;/)
  })
})

describe('requireAdminSession', () => {
  let clock: number
  let protectedApp: Express

  beforeEach(() => {
    clock = 1_000_000
    const sessions = createAdminSessions(t.db, () => clock)
    protectedApp = express()
    protectedApp.use(cookieParser())
    protectedApp.get('/admin/x', requireAdminSession(sessions, {}), (_req, res) => {
      res.json({ ok: true, email: res.locals.user.email })
    })
    t.sessions = sessions
  })

  it('session valide → passe et expose l’utilisateur', async () => {
    await t.users.create('admin@example.com', PW)
    const s = t.sessions.create(1)
    const r = await request(protectedApp).get('/admin/x').set('Cookie', `cq_session=${s}`)
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true, email: 'admin@example.com' })
  })

  it('session expirée → 302 /login?next=… (HTML) ou 401 (JSON)', async () => {
    await t.users.create('admin@example.com', PW)
    const s = t.sessions.create(1)
    clock += 7 * 24 * 3600 * 1000
    const html = await request(protectedApp)
      .get('/admin/x?a=1')
      .set('Accept', 'text/html')
      .set('Cookie', `cq_session=${s}`)
    expect(html.status).toBe(302)
    expect(html.headers.location).toBe('/login?next=%2Fadmin%2Fx%3Fa%3D1')
    const json = await request(protectedApp)
      .get('/admin/x')
      .set('Accept', 'application/json')
      .set('Cookie', `cq_session=${s}`)
    expect(json.status).toBe(401)
    expect(json.body).toEqual({ ok: false, error: 'unauthorized' })
  })
})

describe('cookies en développement', () => {
  it('pas de Secure si NODE_ENV=development', async () => {
    const dev = makeTestApp({ env: testEnv({ nodeEnv: 'development' }) })
    const r = await request(dev.app).get('/login')
    expect(setCookieLines(r, 'cq_csrf')[0]).not.toMatch(/Secure/i)
  })
})

function app() {
  return t.app
}
