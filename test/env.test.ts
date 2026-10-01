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

  it('refuse http avec NODE_ENV=test', () => {
    expect(() => loadEnv({ PUBLIC_URL: 'http://x.com', NODE_ENV: 'test' })).toThrow(/https/)
  })

  describe('bornes des graines', () => {
    const base = { PUBLIC_URL: 'https://q.example.com' }
    it('WEBHOOK_SECRET : 32 à 256 caractères', () => {
      expect(loadEnv({ ...base, WEBHOOK_SECRET: 'a'.repeat(32) }).seed.webhookSecret).toHaveLength(
        32,
      )
      expect(loadEnv({ ...base, WEBHOOK_SECRET: 'a'.repeat(256) }).seed.webhookSecret).toHaveLength(
        256,
      )
      expect(() => loadEnv({ ...base, WEBHOOK_SECRET: 'a'.repeat(31) })).toThrow(/WEBHOOK_SECRET/)
      expect(() => loadEnv({ ...base, WEBHOOK_SECRET: 'a'.repeat(257) })).toThrow(/WEBHOOK_SECRET/)
    })
    it('TTL_HOURS : 1 à 8760', () => {
      expect(loadEnv({ ...base, TTL_HOURS: '1' }).seed.ttlHours).toBe(1)
      expect(loadEnv({ ...base, TTL_HOURS: '8760' }).seed.ttlHours).toBe(8760)
      expect(() => loadEnv({ ...base, TTL_HOURS: '0' })).toThrow(/TTL_HOURS/)
      expect(() => loadEnv({ ...base, TTL_HOURS: '8761' })).toThrow(/TTL_HOURS/)
    })
    it('CLEANUP_INTERVAL_MIN : 1 à 1440', () => {
      expect(loadEnv({ ...base, CLEANUP_INTERVAL_MIN: '1' }).seed.cleanupIntervalMin).toBe(1)
      expect(loadEnv({ ...base, CLEANUP_INTERVAL_MIN: '1440' }).seed.cleanupIntervalMin).toBe(1440)
      expect(() => loadEnv({ ...base, CLEANUP_INTERVAL_MIN: '0' })).toThrow(/CLEANUP_INTERVAL_MIN/)
      expect(() => loadEnv({ ...base, CLEANUP_INTERVAL_MIN: '1441' })).toThrow(
        /CLEANUP_INTERVAL_MIN/,
      )
    })
  })
})

describe('loadEnv : mise à jour', () => {
  const base = { PUBLIC_URL: 'https://q.example.com' }
  const secret = 's'.repeat(32)

  it('updateRepo vaut le dépôt par défaut, surchargeable par UPDATE_REPO', () => {
    expect(loadEnv(base).updateRepo).toBe('KlevisGolemi/cowork-communication')
    expect(loadEnv({ ...base, UPDATE_REPO: 'acme/fork' }).updateRepo).toBe('acme/fork')
    expect(() => loadEnv({ ...base, UPDATE_REPO: 'pas un depot' })).toThrow(/UPDATE_REPO/)
  })
  it('updater absent par défaut, présent si URL et secret sont fournis', () => {
    expect(loadEnv(base).updater).toBeUndefined()
    const env = loadEnv({ ...base, UPDATER_URL: 'http://updater:8081', UPDATER_SECRET: secret })
    expect(env.updater?.url.href).toBe('http://updater:8081/')
    expect(env.updater?.secret).toBe(secret)
  })
  it('exige UPDATER_URL et UPDATER_SECRET ensemble', () => {
    expect(() => loadEnv({ ...base, UPDATER_URL: 'http://updater:8081' })).toThrow(/UPDATER_SECRET/)
    expect(() => loadEnv({ ...base, UPDATER_SECRET: secret })).toThrow(/UPDATER_URL/)
  })
  it('refuse un secret trop court ou une URL invalide', () => {
    expect(() =>
      loadEnv({ ...base, UPDATER_URL: 'http://updater:8081', UPDATER_SECRET: 'court' }),
    ).toThrow(/UPDATER_SECRET/)
    expect(() => loadEnv({ ...base, UPDATER_URL: 'nope', UPDATER_SECRET: secret })).toThrow(
      /UPDATER_URL/,
    )
  })

  it('TRUST_PROXY : 1 par défaut, entier 0 à 5', () => {
    const base = { PUBLIC_URL: 'https://q.example.com' }
    expect(loadEnv(base).trustProxy).toBe(1)
    expect(loadEnv({ ...base, TRUST_PROXY: '' }).trustProxy).toBe(1)
    expect(loadEnv({ ...base, TRUST_PROXY: '0' }).trustProxy).toBe(0)
    expect(loadEnv({ ...base, TRUST_PROXY: '2' }).trustProxy).toBe(2)
    expect(loadEnv({ ...base, TRUST_PROXY: '5' }).trustProxy).toBe(5)
    for (const bad of ['-1', '6', '1.5', 'abc']) {
      expect(() => loadEnv({ ...base, TRUST_PROXY: bad })).toThrow(/TRUST_PROXY/)
    }
  })
})
