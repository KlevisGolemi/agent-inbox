import { createHash } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { createPublicDrop, createSelfLink, type DropServiceDeps } from '../src/drops/service.js'
import { EXTERNAL_WARNING, itemView } from '../src/queue/http.js'
import { createFileStore } from '../src/files/store.js'
import { createUploadManager } from '../src/files/uploads.js'
import { createSettings, seedSettings } from '../src/settings/index.js'
import { makeTestApp, testDb } from './helpers/app.js'
import { finalFiles, PDF_MINI, PNG_1X1, sized, tempFiles } from './helpers/files.js'

const MB = 1024 * 1024
const D = 'Photos des chantiers en cours'

function setup() {
  return makeTestApp()
}
type T = ReturnType<typeof setup>
const svc = (t: T): DropServiceDeps => ({
  drops: t.drops,
  tags: t.tags,
  settings: t.settings,
  publicUrl: t.env.publicUrl,
})
function publicDrop(t: T, over: Partial<Parameters<typeof createPublicDrop>[1]> = {}) {
  const r = createPublicDrop(svc(t), { label: 'Photos chantier', createdBy: 'test', ...over })
  if (!r.ok) throw new Error(r.message)
  return r
}
const pathOf = (url: string) => new URL(url).pathname

describe('création', () => {
  it('jeton de 256 bits montré une fois, seul son sha256 en base', () => {
    const t = setup()
    const d = publicDrop(t)
    const token = pathOf(d.url).slice(3)
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const row = t.db.prepare('SELECT * FROM drops').get() as Record<string, unknown>
    expect(row.token_hash).toBe(createHash('sha256').update(token).digest('hex'))
    expect(JSON.stringify(row)).not.toContain(token)
    expect(JSON.stringify(t.drops.list())).not.toContain(token)
    expect(d.drop).toMatchObject({
      kind: 'public',
      topic: 'drops',
      status: 'active',
      max_files: 10,
    })
  })

  it('bornes des réglages, catégories, tags inconnus, drops désactivés', () => {
    const t = setup()
    expect(
      createPublicDrop(svc(t), { label: 'x', createdBy: 't', expiresInHours: 169 }),
    ).toMatchObject({ ok: false, error: 'out_of_bounds', field: 'expires_in_hours', max: 168 })
    t.settings.set('file_allowed_categories', ['image'])
    expect(
      createPublicDrop(svc(t), { label: 'x', createdBy: 't', allowedCategories: ['video'] }),
    ).toMatchObject({ ok: false, error: 'out_of_bounds', field: 'allowed_categories' })
    expect(createPublicDrop(svc(t), { label: 'x', createdBy: 't', maxFileMb: 21 })).toMatchObject({
      ok: false,
      error: 'out_of_bounds',
      field: 'max_file_mb',
      max: 20,
    })
    expect(
      createPublicDrop(svc(t), { label: 'x', createdBy: 't', tags: ['inconnu'] }),
    ).toMatchObject({ ok: false, error: 'unknown_tags' })
    expect(createPublicDrop(svc(t), { label: '   ', createdBy: 't' })).toMatchObject({
      ok: false,
      error: 'invalid_label',
    })
    t.settings.set('drops_enabled', false)
    expect(createPublicDrop(svc(t), { label: 'x', createdBy: 't' })).toMatchObject({
      ok: false,
      error: 'drops_disabled',
    })
  })
})

describe('page publique', () => {
  it('HTML autonome, CSP stricte, sans cookie, libellé échappé', async () => {
    const t = setup()
    const d = publicDrop(t, { label: '<script>alert(1)</script>' })
    const res = await request(t.app).get(pathOf(d.url))
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/html/)
    expect(res.headers['content-security-policy']).toMatch(/default-src 'none'/)
    expect(res.headers['content-security-policy']).toMatch(/script-src 'nonce-/)
    expect(res.headers['set-cookie']).toBeUndefined()
    expect(res.text).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(res.text).not.toContain('<script>alert(1)')
    expect(res.text).not.toMatch(/<script src=/)
  })

  it('invalide, expiré, révoqué, épuisé ou lien self : même page neutre 404', async () => {
    const t = setup()
    const expired = publicDrop(t)
    t.db.prepare('UPDATE drops SET expires_at = 1 WHERE id = ?').run(expired.drop.id)
    const revoked = publicDrop(t)
    t.drops.revoke(revoked.drop.id)
    const full = publicDrop(t, { maxFiles: 1 })
    t.db.prepare('UPDATE drops SET files_count = 1 WHERE id = ?').run(full.drop.id)
    const self = createSelfLink(svc(t), { createdBy: 't' })
    if (!self.ok) throw new Error('attendu ok')
    const bodies = []
    for (const p of [
      '/d/' + 'A'.repeat(43),
      pathOf(expired.url),
      pathOf(revoked.url),
      pathOf(full.url),
      pathOf(self.url),
    ]) {
      const res = await request(t.app).get(p)
      expect(res.status).toBe(404)
      bodies.push(res.text)
    }
    expect(new Set(bodies).size).toBe(1)
    expect(bodies[0]).toContain('Lien indisponible')
  })

  it('rate-limit par IP sur /d/*', async () => {
    const t = setup()
    t.settings.set('drop_rate_limit_per_min', 2)
    const p = pathOf(publicDrop(t).url)
    await request(t.app).get(p)
    await request(t.app).get(p)
    expect((await request(t.app).get(p)).status).toBe(429)
  })
})

describe('POST /d/<jeton>', () => {
  it('dépôt → message externe (source, topic, tags du drop), drop_events accepted', async () => {
    const t = setup()
    t.tags.create({ name: 'chantier', description: D, createdBy: 't' })
    const d = publicDrop(t, { tags: ['chantier'] })
    const res = await request(t.app)
      .post(pathOf(d.url))
      .field('text', 'Voici la photo')
      .attach('file', PNG_1X1, 'photo.png')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, files: 1 })
    const item = t.repo.search({})[0]!
    expect(item).toMatchObject({
      trust: 'external',
      drop_id: d.drop.id,
      source: 'drop:Photos chantier',
      topic: 'drops',
      tags: ['chantier'],
      payload: { text: 'Voici la photo', drop: { id: d.drop.id, label: 'Photos chantier' } },
    })
    expect(itemView(item)).toMatchObject({
      trust: 'external_unverified',
      warning: EXTERNAL_WARNING,
    })
    expect(t.drops.events(d.drop.id)).toEqual([
      {
        at: expect.any(String),
        outcome: 'accepted',
        files: 1,
        bytes: PNG_1X1.length,
        message_id: item.id,
      },
    ])
    expect(t.drops.get(d.drop.id)!.files_count).toBe(1)
  })

  it('catégorie refusée par le drop : 415, place rendue, rejected:category_not_allowed, aucun résidu', async () => {
    const t = setup()
    const d = publicDrop(t, { allowedCategories: ['image'] })
    const res = await request(t.app).post(pathOf(d.url)).attach('file', PDF_MINI, 'a.pdf')
    expect(res.status).toBe(415)
    expect(t.drops.get(d.drop.id)!.files_count).toBe(0)
    expect(t.drops.events(d.drop.id)[0]).toMatchObject({
      outcome: 'rejected:category_not_allowed',
      files: 0,
    })
    expect(finalFiles(t.files.root)).toEqual([])
    expect(tempFiles(t.files.root)).toEqual([])
  })

  it('texte > 10 Ko : 413 ; aucun fichier : 400 no_file', async () => {
    const t = setup()
    const p = pathOf(publicDrop(t).url)
    expect(
      (
        await request(t.app)
          .post(p)
          .field('text', 'a'.repeat(11 * 1024))
          .attach('file', PNG_1X1, 'p.png')
      ).status,
    ).toBe(413)
    expect((await request(t.app).post(p).field('text', 'bonjour')).body).toMatchObject({
      error: 'no_file',
    })
  })

  it('5 POST parallèles sur un drop max_files 3 : exactement 3 fichiers acceptés', async () => {
    const t = setup()
    const d = publicDrop(t, { maxFiles: 3 })
    const p = pathOf(d.url)
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        request(t.app).post(p).attach('file', PNG_1X1, `p${i}.png`),
      ),
    )
    expect(results.filter((r) => r.status === 200)).toHaveLength(3)
    for (const r of results.filter((x) => x.status !== 200)) expect([404, 413]).toContain(r.status)
    expect(t.drops.get(d.drop.id)!.files_count).toBe(3)
    expect(finalFiles(t.files.root)).toHaveLength(3)
    expect(t.repo.stats().total).toBe(3)
  })

  it('max_file_mb du drop appliqué', async () => {
    const t = setup()
    const d = publicDrop(t, { maxFileMb: 1 })
    expect(
      (
        await request(t.app)
          .post(pathOf(d.url))
          .attach('file', sized(PNG_1X1, 2 * MB), 'p.png')
      ).status,
    ).toBe(413)
    expect(t.drops.get(d.drop.id)!.files_count).toBe(0)
  })
})

describe('lien self', () => {
  it('une seule requête, plusieurs fichiers, trust internal, correlation_id et payload', async () => {
    const t = setup()
    const s = createSelfLink(svc(t), {
      createdBy: 'mcp:codex',
      correlationId: 'job-1',
      payload: { k: 1 },
      topic: 'builds',
    })
    if (!s.ok) throw new Error('attendu ok')
    expect(new Date(s.expires_at).getTime() - Date.now()).toBeLessThanOrEqual(15 * 60_000)
    const p = pathOf(s.url)
    const res = await request(t.app)
      .post(p)
      .attach('file', PDF_MINI, 'a.pdf')
      .attach('file', PNG_1X1, 'b.png')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      ok: true,
      id: expect.any(String),
      attachments: [{ filename: 'a.pdf' }, { filename: 'b.png' }],
    })
    expect(t.repo.findById(res.body.id)).toMatchObject({
      trust: 'internal',
      correlation_id: 'job-1',
      topic: 'builds',
      payload: { k: 1 },
    })
    expect((await request(t.app).post(p).attach('file', PDF_MINI, 'c.pdf')).status).toBe(404)
    expect(t.drops.get(s.drop.id)!.status).toBe('used')
  })

  it('échec (fichier trop gros) : le lien reste utilisable et les places sont rendues', async () => {
    const t = setup()
    t.settings.set('file_max_mb', {
      image: 1,
      audio: 50,
      video: 200,
      document: 50,
      archive: 500,
      other: 100,
    })
    const s = createSelfLink(svc(t), { createdBy: 't' })
    if (!s.ok) throw new Error('attendu ok')
    const p = pathOf(s.url)
    expect(
      (
        await request(t.app)
          .post(p)
          .attach('file', sized(PNG_1X1, 2 * MB), 'p.png')
      ).status,
    ).toBe(413)
    expect(t.drops.get(s.drop.id)).toMatchObject({
      files_count: 0,
      revoked_at: null,
      status: 'active',
    })
    expect((await request(t.app).post(p).attach('file', PNG_1X1, 'p.png')).status).toBe(200)
  })
})

describe('compensation et lien self concurrent', () => {
  it('lien self : deux requêtes simultanées, une seule passe', async () => {
    const t = setup()
    const s = createSelfLink(svc(t), { createdBy: 't' })
    if (!s.ok) throw new Error('attendu ok')
    const p = pathOf(s.url)
    const rs = await Promise.all(
      [1, 2, 3].map((i) => request(t.app).post(p).attach('file', PNG_1X1, `p${i}.png`)),
    )
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1)
    for (const r of rs.filter((x) => x.status !== 200)) expect(r.status).toBe(404)
    expect(t.repo.stats().total).toBe(1)
    expect(t.drops.get(s.drop.id)).toMatchObject({ files_count: 1, status: 'used' })
  })

  it('disque plein : 507, places rendues, lien self restauré, aucun résidu', async () => {
    const db = testDb()
    const settings = createSettings(db)
    seedSettings(settings, db, {}, () => 'g'.repeat(64))
    const files = createFileStore({
      db,
      root: mkdtempSync(join(tmpdir(), 'inbox-files-')),
      log: () => {},
    })
    files.init()
    const uploads = createUploadManager({
      store: files,
      settings,
      statfs: () => ({ bavail: 0, bsize: 1 }),
      log: () => {},
    })
    const t = makeTestApp({ db, settings, files, uploads })
    const s = createSelfLink(svc(t), { createdBy: 't' })
    if (!s.ok) throw new Error('attendu ok')
    const res = await request(t.app).post(pathOf(s.url)).attach('file', PNG_1X1, 'p.png')
    expect(res.status).toBe(507)
    expect(t.drops.get(s.drop.id)).toMatchObject({
      files_count: 0,
      revoked_at: null,
      status: 'active',
    })
    expect(t.drops.events(s.drop.id)[0]).toMatchObject({ outcome: 'rejected:disk_full' })
    expect(finalFiles(files.root)).toEqual([])
    expect(tempFiles(files.root)).toEqual([])
  })

  it('attachments désactivés ou arrêt : place rendue et trace rejected', async () => {
    const t = setup()
    const d = publicDrop(t)
    t.settings.set('attachments_enabled', false)
    const res = await request(t.app).post(pathOf(d.url)).attach('file', PNG_1X1, 'p.png')
    expect(res.status).toBe(403)
    expect(t.drops.get(d.drop.id)!.files_count).toBe(0)
    expect(t.drops.events(d.drop.id)[0]).toMatchObject({ outcome: 'rejected:attachments_disabled' })
  })

  it('correlation_id déjà pris : 409, lien self restauré, fichiers effacés', async () => {
    const t = setup()
    t.repo.enqueue({ payload: {}, source: 'x', correlationId: 'dup-1' })
    const s = createSelfLink(svc(t), { createdBy: 't', correlationId: 'dup-1' })
    if (!s.ok) throw new Error('attendu ok')
    const res = await request(t.app).post(pathOf(s.url)).attach('file', PNG_1X1, 'p.png')
    expect(res.status).toBe(409)
    expect(t.drops.get(s.drop.id)).toMatchObject({ files_count: 0, status: 'active' })
    expect(finalFiles(t.files.root)).toEqual([])
  })

  it('lien self : tag inconnu refusé (tags existants seulement), rien créé', () => {
    const t = setup()
    const r = createSelfLink(svc(t), { createdBy: 't', tags: ['archives-projet'] })
    expect(r).toMatchObject({ ok: false, error: 'unknown_tags' })
    expect(t.tags.get('archives-projet')).toBeNull()
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM drops').get()).toEqual({ n: 0 })
  })

  it('erreur interne sur /d/<jeton> : le jeton n’est jamais journalisé', async () => {
    const base = makeTestApp()
    const repo = {
      ...base.repo,
      enqueue: () => {
        throw new Error('boom')
      },
    }
    const t = makeTestApp({
      db: base.db,
      settings: base.settings,
      files: base.files,
      uploads: base.uploads,
      repo,
    })
    const d = publicDrop(t)
    const token = pathOf(d.url).slice(3)
    const lines: string[] = []
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((c) => {
      lines.push(String(c))
      return true
    })
    try {
      const res = await request(t.app).post(pathOf(d.url)).attach('file', PNG_1X1, 'p.png')
      expect(res.status).toBe(500)
    } finally {
      spy.mockRestore()
    }
    expect(lines.join('')).toContain('Erreur non gérée')
    expect(lines.join('')).not.toContain(token)
    expect(t.drops.get(d.drop.id)!.files_count).toBe(0)
  })

  it('client coupé en plein upload : lien self restauré, rien de résiduel', async () => {
    const t = setup()
    const s = createSelfLink(svc(t), { createdBy: 't' })
    if (!s.ok) throw new Error('attendu ok')
    const server = t.app.listen(0)
    try {
      const { port } = server.address() as AddressInfo
      const boundary = 'xxbound'
      const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="p.png"\r\nContent-Type: image/png\r\n\r\n`
      await new Promise<void>((resolve) => {
        const req = http.request({
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: pathOf(s.url),
          headers: {
            'content-type': `multipart/form-data; boundary=${boundary}`,
            'content-length': String(10 * MB),
          },
        })
        req.on('error', () => resolve())
        req.write(head)
        req.write(Buffer.concat([PNG_1X1, Buffer.alloc(200_000)]))
        setTimeout(() => {
          req.destroy()
          resolve()
        }, 150)
      })
      await vi.waitFor(() => {
        expect(t.drops.events(s.drop.id)[0]).toMatchObject({ outcome: 'rejected:aborted' })
      })
      expect(t.drops.get(s.drop.id)).toMatchObject({
        files_count: 0,
        revoked_at: null,
        status: 'active',
      })
      expect(finalFiles(t.files.root)).toEqual([])
      expect(tempFiles(t.files.root)).toEqual([])
    } finally {
      server.close()
    }
  })

  it('multipart absent : 415 sans toucher au lien self', async () => {
    const t = setup()
    const s = createSelfLink(svc(t), { createdBy: 't' })
    if (!s.ok) throw new Error('attendu ok')
    const res = await request(t.app).post(pathOf(s.url)).send({ a: 1 })
    expect(res.status).toBe(415)
    expect(t.drops.get(s.drop.id)!.status).toBe('active')
  })
})
