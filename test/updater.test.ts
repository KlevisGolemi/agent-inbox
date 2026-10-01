import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { createUpdaterServer, dockerEnv, UPDATE_TIMEOUT_MS } from '../deploy/updater/server.mjs'

const SECRET = 'u'.repeat(32)

function setup(run: () => Promise<void> = async () => {}) {
  const log = vi.fn()
  const runMock = vi.fn(run)
  const server = createUpdaterServer({ secret: SECRET, run: runMock, log })
  return { server, run: runMock, log }
}

/** Laisse la promesse de `run` se résoudre avant d'inspecter le journal. */
const flush = () => new Promise((r) => setImmediate(r))

describe('updater sidecar', () => {
  it('refuse sans secret ou avec un mauvais secret (401) sans rien exécuter', async () => {
    const { server, run } = setup()
    expect((await request(server).post('/update')).status).toBe(401)
    expect(
      (await request(server).post('/update').set('x-updater-secret', 'x'.repeat(32))).status,
    ).toBe(401)
    expect((await request(server).post('/update').set('x-updater-secret', 'court')).status).toBe(
      401,
    )
    expect(run).not.toHaveBeenCalled()
  })

  it('n’expose que POST /update (404 / 405 ailleurs)', async () => {
    const { server, run } = setup()
    const auth = { 'x-updater-secret': SECRET }
    expect((await request(server).get('/update').set(auth)).status).toBe(405)
    expect((await request(server).post('/autre').set(auth)).status).toBe(404)
    expect((await request(server).get('/').set(auth)).status).toBe(404)
    expect(run).not.toHaveBeenCalled()
  })

  it('répond 202 immédiatement et journalise le résultat', async () => {
    const { server, run, log } = setup()
    const res = await request(server).post('/update').set('x-updater-secret', SECRET)
    expect(res.status).toBe(202)
    expect(res.body).toEqual({ ok: true, started: true })
    await flush()
    expect(run).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith('info', expect.stringContaining('terminée'), expect.anything())
  })

  it('journalise un échec sans planter', async () => {
    const { server, log } = setup(async () => {
      throw new Error('pull failed')
    })
    const res = await request(server).post('/update').set('x-updater-secret', SECRET)
    expect(res.status).toBe(202)
    await flush()
    expect(log).toHaveBeenCalledWith('error', expect.stringContaining('échec'), expect.anything())
    // Après un échec, une nouvelle exécution est de nouveau possible.
    const again = await request(server).post('/update').set('x-updater-secret', SECRET)
    expect(again.status).toBe(202)
  })

  it('refuse une exécution concurrente (409)', async () => {
    let release!: () => void
    const { server, run } = setup(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    const auth = { 'x-updater-secret': SECRET }
    expect((await request(server).post('/update').set(auth)).status).toBe(202)
    const second = await request(server).post('/update').set(auth)
    expect(second.status).toBe(409)
    expect(run).toHaveBeenCalledTimes(1)
    release()
    await flush()
    expect((await request(server).post('/update').set(auth)).status).toBe(202)
  })

  it('délai dépassé : processus interrompu, erreur journalisée, nouvelle exécution possible', async () => {
    expect(UPDATE_TIMEOUT_MS).toBe(10 * 60_000)
    const log = vi.fn()
    let received: AbortSignal | undefined
    // Exécution factice qui ne se termine jamais (seule l'annulation est observée).
    const run = vi.fn((signal: AbortSignal) => {
      received = signal
      return new Promise<void>(() => {})
    })
    const server = createUpdaterServer({ secret: SECRET, run, log, timeoutMs: 50 })
    const auth = { 'x-updater-secret': SECRET }
    expect((await request(server).post('/update').set(auth)).status).toBe(202)
    expect((await request(server).post('/update').set(auth)).status).toBe(409)
    await vi.waitFor(() =>
      expect(log).toHaveBeenCalledWith(
        'error',
        expect.stringContaining('délai'),
        expect.anything(),
      ),
    )
    expect(received?.aborted).toBe(true)
    expect((await request(server).post('/update').set(auth)).status).toBe(202)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('refuse un secret absent ou trop court à la création', () => {
    const run = async () => {}
    expect(() => createUpdaterServer({ secret: '', run })).toThrow(/32/)
    expect(() => createUpdaterServer({ secret: 'court', run })).toThrow(/32/)
    expect(() => createUpdaterServer({ secret: undefined as unknown as string, run })).toThrow(/32/)
  })
})

describe('dockerEnv', () => {
  it('ne transmet que les variables nécessaires à docker', () => {
    const env = dockerEnv({
      PATH: '/usr/bin',
      HOME: '/root',
      DOCKER_HOST: 'unix:///x.sock',
      COMPOSE_PROJECT_NAME: 'cq',
      COMPOSE_FILE: 'a.yml',
      UPDATER_SECRET: SECRET,
      PORT: '8081',
    })
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/root',
      DOCKER_HOST: 'unix:///x.sock',
      COMPOSE_PROJECT_NAME: 'cq',
      COMPOSE_FILE: 'a.yml',
    })
    expect(dockerEnv({ PATH: '/bin', UPDATER_SECRET: SECRET })).toEqual({ PATH: '/bin' })
  })
})
