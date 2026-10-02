import http from 'node:http'
import net from 'node:net'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildRuntime } from '../src/bootstrap.js'
import { loadEnv } from '../src/env.js'
import { openDb } from '../src/db/index.js'
import { createWaitPool } from '../src/queue/http.js'
import { createShutdown } from '../src/shutdown.js'
import { makeTestApp } from './helpers/app.js'
import { PDF_MINI, sized } from './helpers/files.js'

const SECRET = 's'.repeat(40)
const H = { 'x-webhook-secret': SECRET }

/** GET sur un serveur à l'écoute ; renvoie statut et corps JSON. */
function get(port: number, path: string, headers: Record<string, string> = H) {
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const req = http.get({ port, path, headers, agent: false }, (res) => {
      let raw = ''
      res.on('data', (c: Buffer) => (raw += c.toString()))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) }))
    })
    req.on('error', reject)
  })
}

describe('arrêt : attentes longues', () => {
  it('une attente ?wait en cours se résout immédiatement en empty à l’arrêt', async () => {
    const ctrl = new AbortController()
    const waits = createWaitPool({ signal: ctrl.signal })
    const t = makeTestApp({ waits })
    t.settings.set('webhook_secret', SECRET)
    const server = t.app.listen(0)
    const { port } = server.address() as AddressInfo
    const pending = get(port, '/next?wait=50')
    await vi.waitFor(() => expect(waits.active).toBe(1))
    const t0 = Date.now()
    ctrl.abort()
    const res = await pending
    expect(res.body).toEqual({ ok: true, empty: true, item: null })
    expect(Date.now() - t0).toBeLessThan(500)
    expect(waits.active).toBe(0)
    // Après l'arrêt, une nouvelle attente ne bloque pas.
    const after = await request(t.app).get('/next?wait=50').set(H)
    expect(after.body.empty).toBe(true)
    server.close()
  })
})

describe('arrêt : uploads en cours', () => {
  it('attend la fin des uploads avant de fermer la base', async () => {
    let release!: () => void
    const uploads = { shutdown: vi.fn(() => new Promise<void>((r) => (release = r))) }
    const db = { close: vi.fn() }
    const server = { close: (cb?: (err?: Error) => void) => cb?.(), closeIdleConnections() {}, closeAllConnections() {} }
    const exit = vi.fn()
    createShutdown({ server, runtime: { shutdown: new AbortController(), db, uploads }, jobs: { stop() {} }, exit, log: () => {} })('SIGTERM')
    expect(uploads.shutdown).toHaveBeenCalledOnce()
    await new Promise((r) => setImmediate(r))
    expect(db.close).not.toHaveBeenCalled()
    release()
    await vi.waitFor(() => expect(db.close).toHaveBeenCalledOnce())
    expect(exit).toHaveBeenCalledWith(0)
  })
})

describe('createShutdown', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cq-shutdown-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('résout les attentes, ferme le serveur et la base, puis exit(0)', async () => {
    const env = loadEnv({
      PUBLIC_URL: 'http://localhost:3000',
      NODE_ENV: 'development',
      DB_PATH: join(dir, 'queue.db'),
    })
    const runtime = await buildRuntime(env)
    runtime.settings.set('webhook_secret', SECRET)
    const jobs = runtime.start()
    const server = runtime.app.listen(0)
    const { port } = server.address() as AddressInfo
    const pending = get(port, '/next?wait=50')
    await vi.waitFor(() => expect(runtime.waits.active).toBe(1))

    const exit = vi.fn()
    const shutdown = createShutdown({ server, runtime, jobs, exit, log: () => {} })
    const t0 = Date.now()
    shutdown('SIGTERM')
    expect((await pending).body).toEqual({ ok: true, empty: true, item: null })
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
    expect(Date.now() - t0).toBeLessThan(3000)
    expect(server.listening).toBe(false)
    expect(runtime.db.open).toBe(false)
  })

  it('arrêt pendant un upload multipart réel : zéro temporaire, zéro ligne, base fermée', async () => {
    const env = loadEnv({ PUBLIC_URL: 'http://localhost:3000', NODE_ENV: 'development', DB_PATH: join(dir, 'queue.db') })
    const runtime = await buildRuntime(env)
    runtime.settings.set('webhook_secret', SECRET)
    runtime.settings.set('storage_min_free_gb', 0)
    const server = runtime.app.listen(0)
    const { port } = server.address() as AddressInfo
    const boundary = 'XB'
    const req = http.request({
      port,
      method: 'POST',
      path: '/webhook',
      headers: { ...H, 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(50 * 1024 * 1024) },
    })
    req.on('error', () => {})
    req.write(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.pdf"\r\n\r\n`)
    req.write(sized(PDF_MINI, 256 * 1024))
    await vi.waitFor(() => expect(runtime.uploads.reservedBytes()).toBeGreaterThan(0))
    const exit = vi.fn()
    createShutdown({ server, runtime, jobs: { stop() {} }, exit, log: () => {} })('SIGTERM')
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0), { timeout: 5000 })
    expect(readdirSync(join(dir, 'files', '.tmp'))).toEqual([])
    expect(runtime.db.open).toBe(false)
    const db = openDb(join(dir, 'queue.db'))
    expect(db.prepare('SELECT COUNT(*) AS n FROM attachments').get()).toEqual({ n: 0 })
    db.close()
    req.destroy()
  })

  it('un socket en fermeture lingering après une erreur d’upload n’empêche pas l’arrêt', async () => {
    const env = loadEnv({ PUBLIC_URL: 'http://localhost:3000', NODE_ENV: 'development', DB_PATH: join(dir, 'queue.db') })
    const runtime = await buildRuntime(env)
    runtime.settings.set('webhook_secret', SECRET)
    runtime.settings.set('attachments_enabled', false) // refus avant lecture : réponse d'erreur, puis lingering
    const server = runtime.app.listen(0)
    const { port } = server.address() as AddressInfo
    const socket = net.connect({ port, host: '127.0.0.1', allowHalfOpen: true })
    let received = ''
    socket.on('data', (c: Buffer) => (received += c.toString()))
    socket.on('error', () => {})
    try {
      socket.write(
        `POST /webhook HTTP/1.1\r\nHost: x\r\nx-webhook-secret: ${SECRET}\r\ncontent-type: multipart/form-data; boundary=XB\r\ncontent-length: ${50 * 1024 * 1024}\r\n\r\n`,
      )
      socket.write(Buffer.alloc(64 * 1024, 0x41)) // puis plus rien : le client ne ferme jamais
      await vi.waitFor(() => expect(received).toMatch(/^HTTP\/1\.1 (4|5)\d\d /))
      const exit = vi.fn()
      const t0 = Date.now()
      createShutdown({ server, runtime, jobs: { stop() {} }, exit, log: () => {} })('SIGTERM')
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0), { timeout: 5000 })
      expect(Date.now() - t0).toBeLessThan(4000) // bien avant les 10 s du lingering
      expect(server.listening).toBe(false)
    } finally {
      socket.destroy()
    }
  })

  it('force la sortie (exit 1) si le serveur ne se ferme pas à temps', async () => {
    vi.useFakeTimers()
    try {
      const exit = vi.fn()
      const fakeServer = {
        close: vi.fn(),
        closeIdleConnections: vi.fn(),
        closeAllConnections: vi.fn(),
      }
      const runtime = { shutdown: new AbortController(), db: { close: vi.fn() } }
      const shutdown = createShutdown({
        server: fakeServer,
        runtime,
        jobs: { stop: vi.fn() },
        exit,
        log: () => {},
      })
      shutdown('SIGTERM')
      shutdown('SIGINT')
      expect(runtime.shutdown.signal.aborted).toBe(true)
      expect(fakeServer.close).toHaveBeenCalledOnce()
      vi.advanceTimersByTime(14_999)
      expect(exit).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(exit).toHaveBeenCalledWith(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
