/**
 * Réponses envoyées avant la fin du corps : fermeture lingering bornée pour une requête
 * authentifiée, fermeture immédiate pour un inconnu (401, 429, jeton invalide, corps trop gros).
 * Clients `net` bruts à demi ouverts : on contrôle quand ils écrivent et on voit le RST éventuel.
 */
import type http from 'node:http'
import net, { type AddressInfo } from 'node:net'
import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { lingerAfterError, lingeringCount } from '../src/files/http.js'
import { createShutdown } from '../src/shutdown.js'
import { makeTestApp } from './helpers/app.js'
import { PDF_MINI, sized } from './helpers/files.js'

const SECRET = 's'.repeat(40)

/**
 * Attente d'une condition par `setImmediate` et l'heure réelle : `vi.waitFor` avance de lui-même
 * une horloge factice, ce qui fausserait les tests de délai.
 */
async function until(check: () => void, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms
  for (;;) {
    try {
      check()
      return
    } catch (err) {
      if (Date.now() > deadline) throw err
      await new Promise((resolve) => setImmediate(resolve))
    }
  }
}
const MB = 1024 * 1024
const BOUNDARY = 'XBOUNDARY'

afterEach(() => {
  vi.useRealTimers()
})

function multipartBody(size: number): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="g.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
    ),
    sized(PDF_MINI, size),
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ])
}

function head(path: string, headers: Record<string, string>): string {
  const lines = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`)
  return `POST ${path} HTTP/1.1\r\nHost: x\r\n${lines.join('')}\r\n`
}

/** Client brut, à demi ouvert ; `serverClosed` : fermeture vue côté serveur. */
function rawClient(server: http.Server) {
  const { port } = server.address() as AddressInfo
  let serverSocket: net.Socket | undefined
  const serverClosed = new Promise<void>((resolve) =>
    server.once('connection', (s: net.Socket) => {
      serverSocket = s
      s.once('close', () => resolve())
    }),
  )
  const socket = net.connect({ port, host: '127.0.0.1', allowHalfOpen: true })
  let received = Buffer.alloc(0)
  const errors: Error[] = []
  socket.on('data', (c: Buffer) => (received = Buffer.concat([received, c])))
  socket.on('error', (e) => errors.push(e))
  const write = (b: Buffer | string) =>
    new Promise<void>((resolve) =>
      socket.write(b, (err) => {
        if (err) errors.push(err)
        resolve()
      }),
    )
  /** Réponse complète (en-têtes + corps JSON selon Content-Length). */
  const response = async () => {
    await until(() => {
      const text = received.toString()
      const sep = text.indexOf('\r\n\r\n')
      expect(sep).toBeGreaterThan(0)
      const len = Number(/content-length: (\d+)/i.exec(text.slice(0, sep))?.[1])
      expect(received.length - (sep + 4)).toBeGreaterThanOrEqual(len)
    })
    const text = received.toString()
    const sep = text.indexOf('\r\n\r\n')
    return {
      status: Number(text.slice(9, 12)),
      head: text.slice(0, sep).toLowerCase(),
      body: JSON.parse(text.slice(sep + 4)) as Record<string, unknown>,
    }
  }
  return { socket, write, errors, response, serverClosed, server: () => serverSocket }
}

/** Promesse résolue avant `ms` (heure réelle), sinon échec nommé. */
async function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let done = false
  const value = p.finally(() => (done = true))
  await until(() => {
    if (!done) throw new Error(`délai dépassé : ${what}`)
  }, ms)
  return value
}

function setup() {
  const t = makeTestApp()
  t.settings.set('webhook_secret', SECRET)
  const server = t.app.listen(0)
  return { t, server }
}

describe('refus anticipés de /webhook et /d/:token', () => {
  it('requête authentifiée, refus d’en-tête (x-topic) pendant l’envoi : 400 lu, corps jeté, fermeture propre', async () => {
    const { server } = setup()
    const body = multipartBody(4 * MB)
    const c = rawClient(server)
    try {
      await c.write(
        head('/webhook', {
          'x-webhook-secret': SECRET,
          'x-topic': 'pas valide !',
          'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`,
          'Content-Length': String(body.length),
          Connection: 'close',
        }),
      )
      await c.write(body.subarray(0, MB))
      const r = await c.response()
      expect(r.status).toBe(400)
      expect(r.body).toMatchObject({ ok: false, error: 'invalid_topic' })
      for (let i = MB; i < body.length; i += 256 * 1024) {
        await c.write(body.subarray(i, i + 256 * 1024))
        await new Promise((resolve) => setImmediate(resolve))
      }
      c.socket.end()
      await within(c.serverClosed, 3000, 'fermeture serveur')
      expect(c.errors).toEqual([])
    } finally {
      c.socket.destroy()
      server.close()
    }
  })

  it('401 (secret absent) pendant l’envoi, client keep-alive : Connection: close, fermeture sans lire le corps', async () => {
    const { t, server } = setup()
    const c = rawClient(server)
    try {
      await c.write(
        head('/webhook', {
          'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`,
          'Content-Length': String(10 * MB),
        }),
      )
      await c.write(multipartBody(64 * 1024).subarray(0, 64 * 1024))
      const r = await c.response()
      expect(r.status).toBe(401)
      expect(r.head).toContain('connection: close')
      await within(c.serverClosed, 3000, 'fermeture serveur')
      expect(lingeringCount()).toBe(0)
      expect(t.uploads.reservedBytes()).toBe(0)
    } finally {
      c.socket.destroy()
      server.close()
    }
  })

  it('429 pendant l’envoi : Connection: close, fermeture immédiate', async () => {
    const { t, server } = setup()
    t.settings.set('webhook_rate_limit_per_min', 1)
    expect(
      (await request(t.app).post('/webhook').set('x-webhook-secret', SECRET).send({ a: 1 })).status,
    ).toBe(200)
    const c = rawClient(server)
    try {
      await c.write(
        head('/webhook', {
          'x-webhook-secret': SECRET,
          'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`,
          'Content-Length': String(10 * MB),
        }),
      )
      await c.write(multipartBody(64 * 1024).subarray(0, 64 * 1024))
      const r = await c.response()
      expect(r.status).toBe(429)
      expect(r.head).toContain('connection: close')
      await within(c.serverClosed, 3000, 'fermeture serveur')
    } finally {
      c.socket.destroy()
      server.close()
    }
  })

  it('JSON annoncé trop gros, appelant inconnu : 413 tout de suite, sans lire le corps, fermeture', async () => {
    const { t, server } = setup()
    t.settings.set('json_max_kb', 16)
    const c = rawClient(server)
    try {
      await c.write(
        head('/webhook', {
          'Content-Type': 'application/json',
          'Content-Length': String(10 * MB),
        }),
      )
      await c.write('{"a":"')
      const r = await c.response()
      expect(r.status).toBe(413)
      expect(r.body).toEqual({ ok: false, error: 'payload_too_large' })
      expect(r.head).toContain('connection: close')
      await within(c.serverClosed, 3000, 'fermeture serveur')
      expect(lingeringCount()).toBe(0)
    } finally {
      c.socket.destroy()
      server.close()
    }
  })

  it('JSON trop gros, secret valide, client qui envoie encore : 413 lu, corps jeté, fermeture propre', async () => {
    const { t, server } = setup()
    t.settings.set('json_max_kb', 16)
    const body = Buffer.from(JSON.stringify({ big: 'x'.repeat(3 * MB) }))
    const c = rawClient(server)
    try {
      await c.write(
        head('/webhook', {
          'x-webhook-secret': SECRET,
          'Content-Type': 'application/json',
          'Content-Length': String(body.length),
          Connection: 'close',
        }),
      )
      await c.write(body.subarray(0, 64 * 1024))
      const r = await c.response()
      expect(r.status).toBe(413)
      expect(r.body).toEqual({ ok: false, error: 'payload_too_large' })
      for (let i = 64 * 1024; i < body.length; i += 256 * 1024) {
        await c.write(body.subarray(i, i + 256 * 1024))
        await new Promise((resolve) => setImmediate(resolve))
      }
      c.socket.end()
      await within(c.serverClosed, 3000, 'fermeture serveur')
      expect(c.errors).toEqual([])
    } finally {
      c.socket.destroy()
      server.close()
    }
  })

  it('drop : jeton inconnu pendant l’envoi : 404, fermeture immédiate (pas de lingering)', async () => {
    const { server } = setup()
    const c = rawClient(server)
    try {
      await c.write(
        head('/d/inconnu', {
          'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`,
          'Content-Length': String(10 * MB),
        }),
      )
      await c.write(multipartBody(64 * 1024).subarray(0, 64 * 1024))
      const r = await c.response()
      expect(r.status).toBe(404)
      expect(r.head).toContain('connection: close')
      await within(c.serverClosed, 3000, 'fermeture serveur')
      expect(lingeringCount()).toBe(0)
    } finally {
      c.socket.destroy()
      server.close()
    }
  })
})

/** Application minimale : refus 413 avec lingering aux bornes données. */
function lingerApp(limits: Parameters<typeof lingerAfterError>[2], respond = true) {
  const app = express()
  app.post('/', (req, res) => {
    lingerAfterError(req, res, limits)
    if (respond) res.status(413).json({ ok: false, error: 'file_too_large' })
  })
  return app.listen(0)
}

async function startUpload(c: ReturnType<typeof rawClient>, total = 10 * MB) {
  await c.write(head('/', { 'Content-Length': String(total) }))
  await c.write(Buffer.alloc(64 * 1024, 0x41))
}

describe('lingerAfterError : bornes', () => {
  it('socket encore ouverte après la réponse, fermée au délai ; minuteur nettoyé', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const server = lingerApp({ ms: 10_000 })
    const c = rawClient(server)
    try {
      await startUpload(c)
      const r = await c.response()
      expect(r.status).toBe(413)
      expect(r.head).toContain('connection: close')
      await new Promise((resolve) => setImmediate(resolve))
      expect(c.server()?.destroyed).toBe(false) // le serveur lit encore (lingering)
      expect(lingeringCount()).toBe(1)
      await c.write(Buffer.alloc(64 * 1024, 0x41)) // toujours accepté, pas de RST
      vi.advanceTimersByTime(9_999)
      await new Promise((resolve) => setImmediate(resolve))
      expect(c.server()?.destroyed).toBe(false)
      vi.advanceTimersByTime(1)
      await within(c.serverClosed, 3000, 'fermeture au délai')
      expect(lingeringCount()).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
      expect(c.errors).toEqual([])
    } finally {
      c.socket.destroy()
      server.close()
    }
  })

  it('le client finit et ferme avant le délai : socket fermée, minuteur annulé', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const server = lingerApp({ ms: 10_000 })
    const c = rawClient(server)
    try {
      await c.write(head('/', { 'Content-Length': String(MB) }))
      await c.write(Buffer.alloc(64 * 1024, 0x41))
      expect((await c.response()).status).toBe(413)
      await c.write(Buffer.alloc(MB - 64 * 1024, 0x41))
      c.socket.end()
      await within(c.serverClosed, 3000, 'fermeture')
      expect(vi.getTimerCount()).toBe(0)
      expect(lingeringCount()).toBe(0)
      expect(c.errors).toEqual([])
    } finally {
      c.socket.destroy()
      server.close()
    }
  })

  it('délai compté dès l’appel, même si la réponse ne part jamais', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const server = lingerApp({ ms: 10_000 }, false)
    const c = rawClient(server)
    try {
      await startUpload(c)
      await until(() => expect(lingeringCount()).toBe(1))
      vi.advanceTimersByTime(10_000)
      await within(c.serverClosed, 3000, 'fermeture au délai')
      expect(lingeringCount()).toBe(0)
    } finally {
      c.socket.destroy()
      server.close()
    }
  })

  it('plafond d’octets jetés : au-delà, la connexion est coupée', async () => {
    const server = lingerApp({ ms: 60_000, maxBytes: MB })
    const c = rawClient(server)
    try {
      await startUpload(c)
      expect((await c.response()).status).toBe(413)
      for (let i = 0; i < 12 && !c.server()?.destroyed; i++) {
        await c.write(Buffer.alloc(256 * 1024, 0x41))
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      await within(c.serverClosed, 3000, 'fermeture au plafond')
      expect(lingeringCount()).toBe(0)
    } finally {
      c.socket.destroy()
      server.close()
    }
  })

  it('plafond global de sockets en lingering : au-delà, fermeture immédiate', async () => {
    const server = lingerApp({ ms: 60_000, maxSockets: 1 })
    const first = rawClient(server)
    try {
      await startUpload(first)
      expect((await first.response()).status).toBe(413)
      expect(lingeringCount()).toBe(1)
      const second = rawClient(server)
      try {
        await startUpload(second)
        const r = await second.response()
        expect(r.status).toBe(413)
        expect(r.head).toContain('connection: close')
        await within(second.serverClosed, 3000, 'fermeture immédiate')
        expect(first.server()?.destroyed).toBe(false)
        expect(lingeringCount()).toBe(1)
      } finally {
        second.socket.destroy()
      }
    } finally {
      first.socket.destroy()
      await within(first.serverClosed, 3000, 'fermeture du premier')
      expect(lingeringCount()).toBe(0)
      server.close()
    }
  })

  it('arrêt : closeAllConnections coupe une socket en lingering, l’arrêt n’attend pas le délai', async () => {
    const server = lingerApp({})
    const c = rawClient(server)
    try {
      await startUpload(c)
      expect((await c.response()).status).toBe(413)
      expect(lingeringCount()).toBe(1)
      const exit = vi.fn()
      createShutdown({
        server,
        runtime: { shutdown: new AbortController(), db: { close: () => undefined } },
        jobs: { stop: () => undefined },
        exit,
        log: () => undefined,
      })('SIGTERM')
      await within(c.serverClosed, 3000, 'coupure à l’arrêt')
      await until(() => expect(exit).toHaveBeenCalledWith(0))
      expect(lingeringCount()).toBe(0)
    } finally {
      c.socket.destroy()
      server.close()
    }
  })
})
