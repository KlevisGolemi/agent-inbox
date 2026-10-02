import { mkdtempSync, rmSync } from 'node:fs'
import { relative } from 'node:path'
import { tmpdir } from 'node:os'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { SESSION_COOKIE } from '../src/auth/sessions.js'
import { AUTO_TAG_DESCRIPTION } from '../src/tags/registry.js'
import { createFileStore } from '../src/files/store.js'
import { makeTestApp } from './helpers/app.js'
import { testDb } from './helpers/app.js'
import { PDF_MINI, PNG_1X1, SVG_ACTIVE } from './helpers/files.js'

const SECRET = 's'.repeat(40)
const D = 'Une description suffisante'

async function setup() {
  const ctx = makeTestApp()
  ctx.settings.set('webhook_secret', SECRET)
  const user = await ctx.users.create('admin@example.test', 'mot-de-passe-initial-1')
  const base = `${SESSION_COOKIE}=${ctx.sessions.create(user.id)}`
  const csrf = (await request(ctx.app).get('/admin/api/overview').set('Cookie', base)).body
    .csrfToken as string
  const cookies = `${base}; inbox_csrf=${csrf}`
  const api = (method: 'post' | 'patch' | 'delete' | 'get', path: string) =>
    request(ctx.app)[method](`/admin/api${path}`).set('Cookie', cookies).set('x-csrf-token', csrf)
  const uploadFile = async (buf: Buffer, name: string) =>
    (
      await request(ctx.app)
        .post('/webhook')
        .set('x-webhook-secret', SECRET)
        .attach('file', buf, name)
    ).body.attachments[0].id as string
  return { ...ctx, api, uploadFile }
}

describe('admin : stockage et pièces jointes', () => {
  it('overview et /storage exposent la jauge', async () => {
    const t = await setup()
    await t.uploadFile(PNG_1X1, 'p.png')
    expect((await t.api('get', '/overview')).body.storage).toMatchObject({
      used_bytes: PNG_1X1.length,
      files_count: 1,
    })
    expect((await t.api('get', '/storage')).body.storage.quota_bytes).toBe(5 * 1024 ** 3)
  })

  it('messages : pièces jointes et badge externe dans la liste', async () => {
    const t = await setup()
    await t.uploadFile(PNG_1X1, 'p.png')
    t.db.prepare("UPDATE messages SET trust = 'external'").run()
    const item = (await t.api('get', '/messages')).body.items[0]
    expect(item).toMatchObject({
      trust: 'external_unverified',
      attachments: [{ filename: 'p.png', category: 'image' }],
    })
  })

  it('aperçu : image inline sans compter, SVG et PDF refusés, sans session 401', async () => {
    const t = await setup()
    const png = await t.uploadFile(PNG_1X1, 'p.png')
    const res = await t.api('get', `/files/${png}/preview`)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('image/png')
    expect(res.headers['content-disposition']).toMatch(/^inline;/)
    expect(res.headers['content-security-policy']).toBe("sandbox; default-src 'none'")
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(t.db.prepare('SELECT downloads FROM attachments').get()).toEqual({ downloads: 0 })
    const svg = await t.api('get', `/files/${await t.uploadFile(SVG_ACTIVE, 's.svg')}/preview`)
    expect(svg.status).toBe(415)
    expect(svg.body.error).toBe('not_previewable')
    expect(
      (await t.api('get', `/files/${await t.uploadFile(PDF_MINI, 'a.pdf')}/preview`)).status,
    ).toBe(415)
    expect(
      (
        await request(t.app)
          .get(`/admin/api/files/${png}/preview`)
          .set('Accept', 'application/json')
      ).status,
    ).toBe(401)
  })

  it('téléchargement : attachment, jamais compté, introuvable 404', async () => {
    const t = await setup()
    const pdf = await t.uploadFile(PDF_MINI, 'a.pdf')
    const res = await t.api('get', `/files/${pdf}/download`)
    expect(res.status).toBe(200)
    expect(res.headers['content-disposition']).toMatch(/^attachment;/)
    expect(res.headers['content-security-policy']).toBe("sandbox; default-src 'none'")
    expect(t.db.prepare('SELECT downloads FROM attachments').get()).toEqual({ downloads: 0 })
    expect((await t.api('get', '/files/inconnu/download')).status).toBe(404)
  })

  it('rotation du secret de signature : nouveau secret, jamais renvoyé', async () => {
    const t = await setup()
    const before = t.settings.get('file_signing_secret')
    const res = await t.api('post', '/settings/file-signing-secret/rotate')
    expect(res.body).toEqual({ ok: true })
    expect(t.settings.get('file_signing_secret')).not.toBe(before)
  })
})

describe('admin : racine de stockage relative', () => {
  it('l’aperçu fonctionne quand la racine des fichiers est un chemin relatif', async () => {
    const abs = mkdtempSync(`${tmpdir()}/inbox-rel-`)
    try {
      const db = testDb()
      const files = createFileStore({ db, root: relative(process.cwd(), abs), log: () => {} })
      files.init()
      const ctx = makeTestApp({ db, files })
      ctx.settings.set('webhook_secret', SECRET)
      const user = await ctx.users.create('admin@example.test', 'mot-de-passe-initial-1')
      const base = `${SESSION_COOKIE}=${ctx.sessions.create(user.id)}`
      const csrf = (await request(ctx.app).get('/admin/api/overview').set('Cookie', base)).body
        .csrfToken as string
      const id = (
        await request(ctx.app)
          .post('/webhook')
          .set('x-webhook-secret', SECRET)
          .attach('file', PNG_1X1, 'p.png')
      ).body.attachments[0].id as string
      const res = await request(ctx.app)
        .get(`/admin/api/files/${id}/preview`)
        .set('Cookie', `${base}; inbox_csrf=${csrf}`)
      expect(res.status).toBe(200)
    } finally {
      rmSync(abs, { recursive: true, force: true })
    }
  })
})

describe('admin : tags', () => {
  it('création, refus d’un proche (409 + similar), force, description, fusion, suppression', async () => {
    const t = await setup()
    expect((await t.api('post', '/tags').send({ name: 'facture', description: D })).status).toBe(
      201,
    )
    const near = await t.api('post', '/tags').send({ name: 'factures', description: D })
    expect(near.status).toBe(409)
    expect(near.body).toMatchObject({ error: 'similar_exists', similar: [{ name: 'facture' }] })
    expect(
      (await t.api('post', '/tags').send({ name: 'factures', description: D, force: true })).status,
    ).toBe(201)
    // resolveForHttp n'écrit plus (R11) : le tag auto est créé comme le fait l'enqueue HTTP.
    t.tags.create({
      name: 'auto',
      description: AUTO_TAG_DESCRIPTION,
      createdBy: 'http:n8n',
      needsDescription: true,
    })
    expect(
      (await t.api('get', '/tags')).body.tags.find((x: { name: string }) => x.name === 'auto')
        .needs_description,
    ).toBe(true)
    expect(
      (await t.api('post', '/tags/factures/merge').send({ into: 'facture' })).body,
    ).toMatchObject({ ok: true })
    expect((await t.api('delete', '/tags/facture')).body).toEqual({ ok: true })
    expect((await t.api('delete', '/tags/facture')).status).toBe(404)
  })

  it('description : efface « à décrire », 404 si inconnu, 400 si trop courte', async () => {
    const t = await setup()
    t.db
      .prepare(
        "INSERT INTO tags (name, description, created_by, created_at, needs_description) VALUES ('auto', 'x', 'http:n8n', 1, 1)",
      )
      .run()
    expect(
      (await t.api('patch', '/tags/auto').send({ description: D })).body.tag.needs_description,
    ).toBe(false)
    expect((await t.api('patch', '/tags/auto').send({ description: 'court' })).status).toBe(400)
    expect((await t.api('patch', '/tags/absent').send({ description: D })).status).toBe(404)
    expect((await t.api('post', '/tags/auto/merge').send({ into: 'auto' })).body.error).toBe(
      'same_tag',
    )
    expect((await t.api('post', '/tags/auto/merge').send({ into: 'absent' })).status).toBe(404)
  })
})

describe('admin : liens de dépôt', () => {
  it('création (URL une fois), liste sans jeton, historique, révocation ; corps invalide 400', async () => {
    const t = await setup()
    const created = await t.api('post', '/drops').send({ label: 'Photos chantier', max_files: 2 })
    expect(created.status).toBe(201)
    const token = new URL(created.body.url).pathname.slice(3)
    const list = await t.api('get', '/drops')
    expect(list.body.drops).toHaveLength(1)
    expect(JSON.stringify(list.body)).not.toContain(token)
    await request(t.app).post(`/d/${token}`).attach('file', PNG_1X1, 'p.png')
    expect(
      (await t.api('get', `/drops/${created.body.drop.id}/events`)).body.events[0],
    ).toMatchObject({ outcome: 'accepted', files: 1 })
    expect((await t.api('delete', `/drops/${created.body.drop.id}`)).body).toEqual({ ok: true })
    expect((await t.api('get', '/drops?all=1')).body.drops[0].status).toBe('revoked')
    expect((await t.api('post', '/drops').send({ label: '' })).status).toBe(400)
    expect(
      (await t.api('post', '/drops').send({ label: 'x', expires_in_hours: 500 })).body,
    ).toMatchObject({ error: 'out_of_bounds' })
  })

  it('tag inconnu refusé (400), tag existant accepté', async () => {
    const t = await setup()
    const bad = await t.api('post', '/drops').send({ label: 'x', tags: ['inconnu'] })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBe('unknown_tags')
    await t.api('post', '/tags').send({ name: 'chantier', description: D })
    expect((await t.api('post', '/drops').send({ label: 'x', tags: ['chantier'] })).status).toBe(
      201,
    )
    expect((await t.api('delete', '/drops/absent')).status).toBe(404)
  })
})
