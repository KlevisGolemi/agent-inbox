import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createQueueRepo } from '../src/queue/repo.js'
import { makeTestApp, testDb } from './helpers/app.js'

const SECRET = 's'.repeat(40)

afterEach(() => vi.restoreAllMocks())

describe('gestionnaire d’erreurs final', () => {
  it('erreur non gérée : 500 JSON générique et une seule ligne de log sans détail sensible', async () => {
    const lines: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk))
      return true
    })
    const db = testDb()
    const repo = createQueueRepo(db)
    repo.stats = () => {
      throw new Error('disque plein\n    at secret (/app/x.js:1:1)')
    }
    const t = makeTestApp({ db, repo })
    t.settings.set('webhook_secret', SECRET)
    const res = await request(t.app).get('/stats?x=1').set('x-webhook-secret', SECRET)
    expect(res.status).toBe(500)
    expect(res.headers['content-type']).toMatch(/application\/json/)
    expect(res.body).toEqual({ ok: false, error: 'internal_error', message: 'Erreur interne.' })
    expect(res.text).not.toContain('disque plein')

    expect(lines).toHaveLength(1)
    expect(lines[0]!.trimEnd().split('\n')).toHaveLength(1)
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>
    expect(entry).toMatchObject({ level: 'error', msg: 'Erreur non gérée', path: '/stats' })
    expect(entry.error).toBe('disque plein')
    expect(lines[0]).not.toContain(SECRET)
  })

  it('les erreurs de corps restent 400 invalid_json et 413 payload_too_large', async () => {
    const t = makeTestApp()
    const bad = await request(t.app)
      .post('/webhook')
      .set('content-type', 'application/json')
      .send('{nope')
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBe('invalid_json')
  })
})
