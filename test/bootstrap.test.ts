import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildRuntime } from '../src/bootstrap.js'
import { LATEST_VERSION } from '../src/db/migrations.js'
import { loadEnv } from '../src/env.js'

let dir: string

function env(extra: Record<string, string> = {}) {
  return loadEnv({
    PUBLIC_URL: 'http://localhost:3000',
    NODE_ENV: 'development',
    DB_PATH: join(dir, 'queue.db'),
    ...extra,
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cq-bootstrap-'))
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe('buildRuntime', () => {
  it('applique les migrations, sert /healthz et crée le dossier de sauvegardes', async () => {
    const rt = await buildRuntime(env())
    expect(rt.db.pragma('user_version', { simple: true })).toBe(LATEST_VERSION)
    const res = await request(rt.app).get('/healthz')
    expect(res.status).toBe(200)
    expect(res.body.version).toBe('2.1.0')
    expect(existsSync(join(dir, 'backups'))).toBe(true)
    rt.db.close()
  })

  it('crée le compte admin depuis l’environnement, sans code de setup', async () => {
    const rt = await buildRuntime(
      env({ ADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: 'correct horse battery' }),
    )
    expect(rt.users.count()).toBe(1)
    expect(rt.setupCode.value).toBeNull()
    rt.db.close()
  })

  it('génère un code de setup quand aucun compte n’existe', async () => {
    const rt = await buildRuntime(env())
    expect(rt.users.count()).toBe(0)
    expect(rt.setupCode.value).toMatch(/^([A-Z2-9]{4}-){5}[A-Z2-9]{4}$/)
    rt.db.close()
  })

  it('start() lance les tâches et stop() les arrête sans timer résiduel', async () => {
    vi.useFakeTimers()
    try {
      const rt = await buildRuntime(env())
      // Le routeur crée ses propres timers (rate limit) : on compare avant/après.
      const before = vi.getTimerCount()
      const handle = rt.start()
      expect(vi.getTimerCount()).toBeGreaterThan(before)
      handle.stop()
      expect(vi.getTimerCount()).toBe(before)
      rt.db.close()
    } finally {
      vi.useRealTimers()
    }
  })
})
