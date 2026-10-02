import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { jsonLimitFor } from '../src/http/jsonBody.js'
import { makeTestApp } from './helpers/app.js'

const SECRET = 's'.repeat(40)
const H = { 'x-webhook-secret': SECRET }
const MB = 1024 * 1024

function setup() {
  const t = makeTestApp()
  t.settings.set('webhook_secret', SECRET)
  return t
}

describe('parseur JSON par route', () => {
  it('/webhook suit json_max_kb, modifié à chaud', async () => {
    const t = setup()
    t.settings.set('json_max_kb', 16)
    const big = await request(t.app)
      .post('/webhook')
      .set(H)
      .send({ x: 'a'.repeat(20 * 1024) })
    expect(big.status).toBe(413)
    expect(big.body).toEqual({ ok: false, error: 'payload_too_large' })
    const small = await request(t.app)
      .post('/webhook')
      .set(H)
      .send({ x: 'a'.repeat(10 * 1024) })
    expect(small.status).toBe(200)
    t.settings.set('json_max_kb', 64)
    expect(
      (
        await request(t.app)
          .post('/webhook')
          .set(H)
          .send({ x: 'a'.repeat(20 * 1024) })
      ).status,
    ).toBe(200)
  })

  it('/mcp : json_max_kb + ⌈mcp_upload_max_mb × 1,37⌉ Mo + 64 Ko', () => {
    const t = setup()
    expect(jsonLimitFor('/mcp', t.settings)).toBe(1024 * 1024 + 7 * MB + 64 * 1024)
    t.settings.set('mcp_upload_max_mb', 0)
    expect(jsonLimitFor('/mcp', t.settings)).toBe(1024 * 1024 + 64 * 1024)
  })

  it('/mcp accepte un corps de 2 Mo (lu puis refusé par l’authentification, pas par la taille)', async () => {
    const t = setup()
    const res = await request(t.app)
      .post('/mcp')
      .set({ accept: 'application/json, text/event-stream', 'content-type': 'application/json' })
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { pad: 'a'.repeat(2 * MB) } })
    expect(res.status).toBe(401)
  })

  it('autres routes : 1 Mo inchangé', () => {
    const t = setup()
    expect(jsonLimitFor('/admin/api/settings', t.settings)).toBe(MB)
    expect(jsonLimitFor('/token', t.settings)).toBe(MB)
  })

  it('JSON invalide : 400 invalid_json inchangé', async () => {
    const t = setup()
    const res = await request(t.app)
      .post('/webhook')
      .set(H)
      .set('content-type', 'application/json')
      .send('{x')
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ ok: false, error: 'invalid_json' })
  })
})
