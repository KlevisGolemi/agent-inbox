import { describe, it, expect } from 'vitest'
import { loadEnv } from '../src/env.js'

describe('loadEnv', () => {
  it('exige PUBLIC_URL', () => {
    expect(() => loadEnv({})).toThrow(/PUBLIC_URL/)
  })
  it('refuse http en production', () => {
    expect(() => loadEnv({ PUBLIC_URL: 'http://x.com' })).toThrow(/https/)
  })
  it('accepte http en développement et normalise le slash final', () => {
    const env = loadEnv({ PUBLIC_URL: 'http://localhost:3000/', NODE_ENV: 'development' })
    expect(env.publicUrl.href).toBe('http://localhost:3000/')
    expect(env.port).toBe(3000)
    expect(env.dbPath).toBe('/data/queue.db')
  })
  it('lit les graines v1', () => {
    const env = loadEnv({
      PUBLIC_URL: 'https://q.example.com',
      WEBHOOK_SECRET: 'a'.repeat(64),
      TTL_HOURS: '24',
    })
    expect(env.seed).toEqual({
      webhookSecret: 'a'.repeat(64),
      ttlHours: 24,
      cleanupIntervalMin: undefined,
    })
  })
})
