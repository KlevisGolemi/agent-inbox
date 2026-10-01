import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTestApp, testEnv } from './helpers/app.js'

/** IP vue par l'application : relevée dans le journal « Auth refusée » (req.ip). */
async function seenIp(trustProxy: number, forwardedFor: string): Promise<string> {
  const lines: string[] = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    lines.push(String(chunk))
    return true
  })
  const { app } = makeTestApp({ env: testEnv({ trustProxy }) })
  await request(app).post('/webhook').set('X-Forwarded-For', forwardedFor).send({})
  const entry = lines
    .map((l) => JSON.parse(l) as { msg: string; ip?: string })
    .find((e) => e.msg === 'Auth refusée')
  return entry?.ip ?? ''
}

afterEach(() => vi.restoreAllMocks())

describe('TRUST_PROXY', () => {
  // Cloudflare ajoute le client, Traefik ajoute l'IP de Cloudflare : « client, cloudflare ».
  const chain = '203.0.113.9, 198.51.100.7'

  it('2 proxys : req.ip est le client, pas Cloudflare', async () => {
    expect(await seenIp(2, chain)).toBe('203.0.113.9')
  })

  it('1 proxy : req.ip est l’adresse du dernier saut (Cloudflare)', async () => {
    expect(await seenIp(1, chain)).toBe('198.51.100.7')
  })
})
