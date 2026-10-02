import fs from 'node:fs'
import http from 'node:http'
import net, { type AddressInfo } from 'node:net'
import request, { type Response } from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import { lingerAfterError } from '../src/files/http.js'
import { signFileUrl } from '../src/files/links.js'
import { rotateFileSigningSecret } from '../src/settings/index.js'
import { makeTestApp } from './helpers/app.js'
import { finalFiles, PDF_MINI, sized, tempFiles } from './helpers/files.js'

const SECRET = 's'.repeat(40)
const H = { 'x-webhook-secret': SECRET }
const MB = 1024 * 1024
const CATS = { image: 20, audio: 50, video: 200, document: 50, archive: 500, other: 100 }

function setup() {
  const t = makeTestApp()
  t.settings.set('webhook_secret', SECRET)
  return t
}
type T = ReturnType<typeof setup>

/** Lecture binaire du corps (Supertest). */
const binary = (res: Response, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = []
  res.on('data', (c: Buffer) => chunks.push(c))
  res.on('end', () => cb(null, Buffer.concat(chunks)))
}

function upload(
  t: T,
  headers: Record<string, string> = {},
  name = 'facture.pdf',
  buf: Buffer = PDF_MINI,
) {
  return request(t.app)
    .post('/webhook')
    .set(H)
    .set(headers)
    .field('payload', JSON.stringify({ client: 'ACME' }))
    .attach('file', buf, { filename: name, contentType: 'application/pdf' })
}

const pathOf = (url: string) => {
  const u = new URL(url)
  return u.pathname + u.search
}

function noResidue(t: T) {
  expect(t.repo.stats().total).toBe(0)
  expect(finalFiles(t.files.root)).toEqual([])
  expect(tempFiles(t.files.root)).toEqual([])
  expect(t.uploads.reservedBytes()).toBe(0)
}

describe('POST /webhook multipart', () => {
  it('PDF + payload + x-tags : message, pièce, tag créé « à décrire »', async () => {
    const t = setup()
    const r = await upload(t, { 'x-tags': 'Facture', 'x-topic': 'compta' })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({
      ok: true,
      topic: 'compta',
      tags: ['facture'],
      attachments: [
        {
          filename: 'facture.pdf',
          mime_type: 'application/pdf',
          category: 'document',
          size_bytes: PDF_MINI.length,
        },
      ],
    })
    const next = await request(t.app).get('/next?topic=compta').set(H)
    expect(next.body.item).toMatchObject({
      payload: { client: 'ACME' },
      tags: ['facture'],
      attachments: [{ status: 'available', on_download: 'keep' }],
    })
    expect(t.tags.get('facture')).toMatchObject({ needs_description: true })
  })

  it('JSON + x-tags : tags renvoyés ; x-tags invalide → 400', async () => {
    const t = setup()
    const ok = await request(t.app)
      .post('/webhook')
      .set(H)
      .set('x-tags', 'urgent, Client VIP')
      .send({ a: 1 })
    expect(ok.body).toMatchObject({ ok: true, tags: ['urgent', 'client-vip'] })
    const bad = await request(t.app).post('/webhook').set(H).set('x-tags', '!!!').send({ a: 1 })
    expect(bad.status).toBe(400)
    expect(bad.body).toMatchObject({ ok: false, error: 'invalid_tags', invalid: ['!!!'] })
  })

  it('JSON sans x-tags : pas de champ tags dans la réponse', async () => {
    const t = setup()
    const r = await request(t.app).post('/webhook').set(H).send({ a: 1 })
    expect(r.body).not.toHaveProperty('tags')
  })

  it('x-on-download invalide : 400 ; payload JSON invalide : 400 sans résidu', async () => {
    const t = setup()
    expect((await upload(t, { 'x-on-download': 'delete' })).body).toMatchObject({
      error: 'invalid_on_download',
    })
    const r = await request(t.app)
      .post('/webhook')
      .set(H)
      .field('payload', '{x')
      .attach('file', PDF_MINI, 'a.pdf')
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('invalid_json')
    noResidue(t)
  })

  it('fichier trop gros pour sa catégorie : 413 sans résidu', async () => {
    const t = setup()
    t.settings.set('file_max_mb', { ...CATS, document: 1 })
    const r = await upload(t, {}, 'gros.pdf', sized(PDF_MINI, 2 * MB))
    expect(r.status).toBe(413)
    expect(r.body).toMatchObject({ ok: false, error: 'file_too_large' })
    noResidue(t)
  })

  it('fichier trop gros, client « Connection: close » qui envoie encore : 413 lu, fermeture propre sans RST', async () => {
    const t = setup()
    t.settings.set('file_max_mb', { ...CATS, document: 1 })
    const server = t.app.listen(0)
    const { port } = server.address() as AddressInfo
    const boundary = 'XBOUNDARY'
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="g.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
      ),
      sized(PDF_MINI, 4 * MB),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ])
    // allowHalfOpen : le FIN du serveur (réponse finie) ne ferme pas notre côté, on peut continuer
    // d'écrire, comme un client qui ne lit la réponse qu'après avoir tout envoyé.
    const socket = net.connect({ port, host: '127.0.0.1', allowHalfOpen: true })
    let received = Buffer.alloc(0)
    let socketError: Error | null = null
    socket.on('data', (c: Buffer) => (received = Buffer.concat([received, c])))
    socket.on('error', (e) => (socketError = e))
    const ended = new Promise<void>((resolve) => socket.once('close', () => resolve()))
    const write = (b: Buffer) =>
      new Promise<void>((resolve) =>
        socket.write(b, (err) => {
          if (err) socketError ??= err
          resolve()
        }),
      )
    try {
      await write(
        Buffer.from(
          `POST /webhook HTTP/1.1\r\nHost: x\r\nx-webhook-secret: ${SECRET}\r\n` +
            `Content-Type: multipart/form-data; boundary=${boundary}\r\n` +
            `Content-Length: ${body.length}\r\nConnection: close\r\n\r\n`,
        ),
      )
      // Assez pour dépasser la limite, puis on attend la réponse avant d'envoyer la suite.
      await write(body.subarray(0, 2 * MB))
      await vi.waitFor(() => expect(received.toString()).toContain('"file_too_large"'), {
        timeout: 5000,
      })
      // Le client, comme la plupart, finit d'envoyer son corps : le serveur doit le lire et le
      // jeter, pas fermer brutalement (RST → EPIPE/ECONNRESET, réponse possiblement perdue).
      for (let i = 2 * MB; i < body.length; i += 256 * 1024) {
        await write(body.subarray(i, i + 256 * 1024))
        await new Promise((resolve) => setImmediate(resolve))
      }
      socket.end()
      await ended
      expect(socketError).toBeNull()
      const text = received.toString()
      expect(text).toMatch(/^HTTP\/1\.1 413 /)
      expect(text.toLowerCase()).toContain('connection: close')
      expect(JSON.parse(text.slice(text.indexOf('\r\n\r\n') + 4))).toMatchObject({
        ok: false,
        error: 'file_too_large',
      })
      noResidue(t)
    } finally {
      socket.destroy()
      server.close()
    }
  })

  it('doublon de correlation_id : 409, pièce effacée et aucun tag « à décrire » laissé', async () => {
    const t = setup()
    await request(t.app).post('/webhook').set(H).set('x-correlation-id', 'c1').send({ a: 1 })
    const r = await upload(t, { 'x-correlation-id': 'c1', 'x-tags': 'orphelin' })
    expect(r.status).toBe(409)
    expect(r.body.error).toBe('duplicate_correlation_id')
    expect(finalFiles(t.files.root)).toEqual([])
    expect(tempFiles(t.files.root)).toEqual([])
    expect(t.tags.get('orphelin')).toBeNull()
  })

  it('attachments_enabled=false : multipart 403, JSON toujours accepté', async () => {
    const t = setup()
    t.settings.set('attachments_enabled', false)
    expect((await upload(t)).status).toBe(403)
    expect((await request(t.app).post('/webhook').set(H).send({ a: 1 })).status).toBe(200)
  })

  it('disque sous storage_min_free_gb : 507, mais un fichier existant reste téléchargeable', async () => {
    const t = setup()
    const first = await upload(t)
    t.settings.set('storage_min_free_gb', 1000)
    const r = await upload(t, {}, 'b.pdf')
    expect(r.status).toBe(507)
    expect(r.body.error).toBe('disk_full')
    const dl = await request(t.app).get(`/files/${first.body.attachments[0].id}`).set(H)
    expect(dl.status).toBe(200)
  })

  it('client qui coupe au milieu : zéro temporaire, zéro ligne, réservation libérée', async () => {
    const t = setup()
    const server = t.app.listen(0)
    const { port } = server.address() as AddressInfo
    const boundary = 'XBOUNDARY'
    const req = http.request({
      port,
      method: 'POST',
      path: '/webhook',
      headers: {
        ...H,
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': String(10 * MB),
      },
    })
    req.on('error', () => {})
    req.write(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
    )
    req.write(sized(PDF_MINI, 256 * 1024))
    await vi.waitFor(() => expect(t.uploads.reservedBytes()).toBeGreaterThan(0))
    req.destroy()
    await vi.waitFor(() => {
      expect(t.uploads.reservedBytes()).toBe(0)
      expect(tempFiles(t.files.root)).toEqual([])
    })
    noResidue(t)
    server.close()
  })
})

describe('GET /files/:id', () => {
  it('avec le secret : contenu, en-têtes de sécurité, downloads compté une fois', async () => {
    const t = setup()
    const id = (await upload(t)).body.attachments[0].id
    const res = await request(t.app).get(`/files/${id}`).set(H).buffer(true).parse(binary)
    expect(res.status).toBe(200)
    expect(res.body).toEqual(PDF_MINI)
    expect(res.headers).toMatchObject({
      'content-type': 'application/pdf',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "sandbox; default-src 'none'",
      'cache-control': 'private, no-store',
      'content-disposition': `attachment; filename="facture.pdf"; filename*=UTF-8''facture.pdf`,
    })
    expect(t.db.prepare('SELECT downloads FROM attachments').get()).toEqual({ downloads: 1 })
  })

  it('sans secret ni signature : 401 ; identifiant inconnu : 404', async () => {
    const t = setup()
    const id = (await upload(t)).body.attachments[0].id
    expect((await request(t.app).get(`/files/${id}`)).status).toBe(401)
    expect(
      (await request(t.app).get('/files/00000000-0000-4000-8000-000000000000').set(H)).status,
    ).toBe(404)
  })

  it('lien signé : valide 200 ; expiré, falsifié ou après rotation : 404 neutre', async () => {
    const t = setup()
    const id = (await upload(t)).body.attachments[0].id
    const sign = (now: number) =>
      pathOf(
        signFileUrl({
          publicUrl: t.env.publicUrl,
          id,
          secret: t.settings.get('file_signing_secret'),
          ttlMin: 60,
          now,
        }).url,
      )
    const valid = sign(Date.now())
    expect((await request(t.app).get(valid)).status).toBe(200)
    expect((await request(t.app).get(sign(Date.now() - 2 * 3_600_000))).body).toEqual({
      ok: false,
      error: 'not_found',
    })
    expect((await request(t.app).get(valid + 'x')).status).toBe(404)
    rotateFileSigningSecret(t.settings)
    expect((await request(t.app).get(valid)).status).toBe(404)
  })

  it('keep : Range → 206 non compté ; HEAD non compté', async () => {
    const t = setup()
    const id = (await upload(t)).body.attachments[0].id
    const part = await request(t.app).get(`/files/${id}`).set(H).set('Range', 'bytes=0-3')
    expect(part.status).toBe(206)
    expect((await request(t.app).head(`/files/${id}`).set(H)).status).toBe(200)
    expect(t.db.prepare('SELECT downloads FROM attachments').get()).toEqual({ downloads: 0 })
  })

  it('consume : Range ignoré (200 complet, Accept-Ranges none), retéléchargeable pendant la grâce', async () => {
    const t = setup()
    const id = (await upload(t, { 'x-on-download': 'consume' })).body.attachments[0].id
    const a = await request(t.app)
      .get(`/files/${id}`)
      .set(H)
      .set('Range', 'bytes=0-3')
      .buffer(true)
      .parse(binary)
    expect(a.status).toBe(200)
    expect(a.headers['accept-ranges']).toBe('none')
    expect(a.body).toEqual(PDF_MINI)
    await vi.waitFor(() =>
      expect(t.db.prepare('SELECT downloads FROM attachments').get()).toEqual({ downloads: 1 }),
    )
    const b = await request(t.app).get(`/files/${id}`).set(H).buffer(true).parse(binary)
    expect(b.status).toBe(200)
    await vi.waitFor(() =>
      expect(
        t.db
          .prepare('SELECT downloads, first_downloaded_at IS NOT NULL AS first FROM attachments')
          .get(),
      ).toEqual({ downloads: 2, first: 1 }),
    )
  })

  it('consume : client qui ferme dès le dernier octet reçu, avant la fin du flux de lecture : livraison comptée', async () => {
    const t = setup()
    const id = (await upload(t, { 'x-on-download': 'consume' })).body.attachments[0].id
    // Le flux de lecture ne voit la fin du fichier qu'à une lecture supplémentaire. On la retient
    // jusqu'à ce que le client ait fermé : c'est l'ordre observé sous charge (client servi, puis
    // connexion fermée, avant que le serveur n'appelle end()).
    const realRead = fs.read.bind(fs) as (...a: unknown[]) => void
    let reads = 0
    let release: (() => void) | undefined
    const spy = vi.spyOn(fs, 'read').mockImplementation(((...args: unknown[]) => {
      const cb = args.pop() as (...r: unknown[]) => void
      if (++reads === 1) return realRead(...args, cb)
      // Lecture de fin de fichier : émise, mais exécutée seulement quand le test la libère.
      release = () => {
        release = () => undefined
        realRead(...args, cb)
      }
    }) as never)
    const server = t.app.listen(0)
    const serverClosed = new Promise((resolve) =>
      server.once('connection', (socket) => socket.once('close', resolve)),
    )
    try {
      const { port } = server.address() as AddressInfo
      const body = await new Promise<Buffer>((resolve, reject) => {
        http
          .get({ port, path: `/files/${id}`, headers: H, agent: false }, (res) => {
            const chunks: Buffer[] = []
            res.on('data', (c: Buffer) => chunks.push(c))
            res.on('end', () => {
              res.socket.destroy() // tout reçu (Content-Length) : le client ferme aussitôt
              resolve(Buffer.concat(chunks))
            })
          })
          .on('error', reject)
      })
      expect(body).toEqual(PDF_MINI)
      await serverClosed // le serveur a vu la fermeture, fin du fichier toujours pas lue
      expect(release).toBeDefined()
      release?.()
      await vi.waitFor(() =>
        expect(t.db.prepare('SELECT downloads FROM attachments').get()).toEqual({ downloads: 1 }),
      )
    } finally {
      spy.mockRestore()
      release?.()
      server.close()
    }
  })

  it('nom accentué : filename ASCII de repli et filename* RFC 5987', async () => {
    const t = setup()
    const id = (await upload(t, {}, 'résumé final.pdf')).body.attachments[0].id
    const res = await request(t.app).get(`/files/${id}`).set(H)
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="r_sum_ final.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9%20final.pdf`,
    )
  })

  it('pièce expirée : 410 expired', async () => {
    const t = setup()
    const id = (await upload(t)).body.attachments[0].id
    t.db.prepare('UPDATE attachments SET expires_at = 1').run()
    expect((await request(t.app).get(`/files/${id}`).set(H)).body).toEqual({
      ok: false,
      error: 'expired',
    })
  })
})

describe('lingerAfterError', () => {
  it('client qui n’en finit pas d’envoyer : réponse reçue, puis connexion fermée après le délai borné', async () => {
    const app = express()
    app.post('/', (req, res) => {
      lingerAfterError(req, res, 50)
      res.status(413).json({ ok: false, error: 'file_too_large' })
    })
    const server = app.listen(0)
    const { port } = server.address() as AddressInfo
    // Fermeture vue côté serveur : le client, à demi ouvert, ne ferme jamais de lui-même.
    const closed = new Promise<void>((resolve) =>
      server.once('connection', (s: net.Socket) => s.once('close', () => resolve())),
    )
    const socket = net.connect({ port, host: '127.0.0.1', allowHalfOpen: true })
    let received = ''
    socket.on('data', (c: Buffer) => (received += c.toString()))
    socket.on('error', () => {})
    try {
      socket.write(`POST / HTTP/1.1\r\nHost: x\r\nContent-Length: ${10 * MB}\r\n\r\n`)
      socket.write(Buffer.alloc(64 * 1024, 0x41)) // puis plus rien : le corps n’est jamais complet
      await closed
      expect(received).toMatch(/^HTTP\/1\.1 413 /)
      expect(received).toContain('"file_too_large"')
    } finally {
      socket.destroy()
      server.close()
    }
  })
})
