import type Database from 'better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb } from '../src/db/index.js'
import { migrate } from '../src/db/migrations.js'
import { startCleanup } from '../src/jobs/cleanup.js'
import { createQueueRepo, type QueueRepo } from '../src/queue/repo.js'
import { createSettings, seedSettings, type Settings } from '../src/settings/index.js'

const HOUR = 3_600_000
const quiet = () => {}
let db: Database.Database
let clock: number
let repo: QueueRepo
let settings: Settings
let timers: { fn: () => void; ms: number; id: number; cleared: boolean }[]

const setTimer = ((fn: () => void, ms: number) => {
  const t = { fn, ms, id: timers.length, cleared: false }
  timers.push(t)
  return t
}) as unknown as typeof setTimeout
const clearTimer = ((t: { cleared: boolean }) => {
  t.cleared = true
}) as unknown as typeof clearTimeout

function start(log = vi.fn()) {
  return {
    log,
    job: startCleanup({ db, repo, settings, log, now: () => clock, setTimer, clearTimer }),
  }
}

beforeEach(() => {
  db = openDb(':memory:')
  migrate(db, quiet)
  clock = 1_000_000_000_000
  timers = []
  repo = createQueueRepo(db, { now: () => clock, leaseTimeoutMs: () => 60_000 })
  settings = createSettings(db)
  seedSettings(settings, db, {}, () => 'x'.repeat(64))
})

function addRead(topic?: string) {
  repo.enqueue({ payload: {}, source: 't', correlationId: null, ...(topic ? { topic } : {}) })
  repo.claimNext(topic ? { topic } : {})
}

describe('nettoyage', () => {
  it('supprime un message lu depuis 49 h avec un TTL de 48 h, le garde après réglage à 72 h', () => {
    addRead()
    clock += 49 * HOUR
    settings.set('ttl_hours', 72)
    const { job } = start()
    expect(job.runOnce().readDeleted).toBe(0)
    settings.set('ttl_hours', 48)
    expect(job.runOnce().readDeleted).toBe(1)
  })

  it('applique le TTL par topic : logs à 1 h supprimé, default à 48 h conservé', () => {
    const { job } = start()
    addRead('logs')
    addRead()
    clock += 2 * HOUR
    settings.set('topic_ttl_overrides', { logs: 1 })
    expect(job.runOnce().readDeleted).toBe(1)
    expect(repo.search({ status: 'read' }).map((m) => m.topic)).toEqual(['default'])
  })

  it('compte les messages en attente expirés', () => {
    const { job } = start()
    repo.enqueue({ payload: {}, source: 't', correlationId: null })
    clock += 49 * HOUR
    expect(job.runOnce().pendingExpired).toBe(1)
  })

  it('supprime codes et jetons expirés et sessions expirées ; garde les jetons révoqués non expirés', () => {
    const { job } = start()
    db.prepare("INSERT INTO oauth_clients VALUES ('c', '{}', 0)").run()
    db.prepare("INSERT INTO users VALUES (1, 'a@b.c', 'h', 0)").run()
    const code = db.prepare("INSERT INTO oauth_codes VALUES (?, 'c', 1, 'ch', 'u', 's', NULL, ?)")
    code.run('old', clock - 1)
    code.run('new', clock + 1000)
    const tok = db.prepare(
      "INSERT INTO oauth_tokens VALUES (?, 'access', 'c', 1, 's', NULL, ?, ?, 0)",
    )
    tok.run('expired', clock - 1, 0)
    // Révoqué mais non expiré : conservé, nécessaire à la détection de réutilisation du refresh.
    tok.run('revoked', clock + 1000, 1)
    tok.run('valid', clock + 1000, 0)
    const sess = db.prepare('INSERT INTO admin_sessions VALUES (?, 1, ?)')
    sess.run('old', clock - 1)
    sess.run('new', clock + 1000)

    const report = job.runOnce()
    expect(report).toMatchObject({ oauthDeleted: 2, sessionsDeleted: 1 })
    const left = (t: string) => db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }
    expect([left('oauth_codes').n, left('oauth_tokens').n, left('admin_sessions').n]).toEqual([
      1, 2, 1,
    ])
  })

  it('supprime les clients OAuth de plus de 30 jours sans jeton actif (cascade)', () => {
    const { job } = start()
    db.prepare("INSERT INTO users VALUES (1, 'a@b.c', 'h', 0)").run()
    const DAY = 24 * HOUR
    const client = db.prepare("INSERT INTO oauth_clients VALUES (?, '{}', ?)")
    client.run('old-idle', clock - 31 * DAY)
    client.run('old-revoked', clock - 31 * DAY)
    client.run('old-active', clock - 31 * DAY)
    client.run('recent', clock - 29 * DAY)
    const tok = db.prepare(
      "INSERT INTO oauth_tokens VALUES (?, 'refresh', ?, 1, 's', NULL, ?, ?, 0)",
    )
    tok.run('r1', 'old-revoked', clock + DAY, 1)
    tok.run('a1', 'old-active', clock + DAY, 0)
    db.prepare("INSERT INTO oauth_codes VALUES ('k', 'old-idle', 1, 'ch', 'u', 's', NULL, ?)").run(
      clock + 1000,
    )

    expect(job.runOnce()).toMatchObject({ clientsDeleted: 2 })
    const ids = (
      db.prepare('SELECT client_id FROM oauth_clients ORDER BY client_id').all() as {
        client_id: string
      }[]
    ).map((r) => r.client_id)
    expect(ids).toEqual(['old-active', 'recent'])
    // Jetons et codes des clients supprimés partis avec eux (ON DELETE CASCADE).
    expect(db.prepare('SELECT token_hash FROM oauth_tokens').all()).toEqual([{ token_hash: 'a1' }])
    expect(db.prepare('SELECT count(*) AS n FROM oauth_codes').get()).toEqual({ n: 0 })
  })

  it('supprime à la frontière exacte expires_at === now', () => {
    const { job } = start()
    db.prepare("INSERT INTO oauth_clients VALUES ('c', '{}', 0)").run()
    db.prepare("INSERT INTO users VALUES (1, 'a@b.c', 'h', 0)").run()
    db.prepare("INSERT INTO oauth_codes VALUES ('k', 'c', 1, 'ch', 'u', 's', NULL, ?)").run(clock)
    db.prepare("INSERT INTO oauth_tokens VALUES ('t', 'access', 'c', 1, 's', NULL, ?, 0, 0)").run(
      clock,
    )
    db.prepare('INSERT INTO admin_sessions VALUES (?, 1, ?)').run('s', clock)
    expect(job.runOnce()).toMatchObject({ oauthDeleted: 2, sessionsDeleted: 1 })
  })

  it('logue en info seulement si quelque chose a été supprimé', () => {
    const { job, log } = start()
    job.runOnce()
    expect(log).not.toHaveBeenCalled()
    addRead()
    clock += 49 * HOUR
    job.runOnce()
    expect(log).toHaveBeenCalledWith(
      'info',
      expect.any(String),
      expect.objectContaining({ readDeleted: 1 }),
    )
  })
})

describe('planification', () => {
  it('exécute une passe au démarrage puis planifie avec cleanup_interval_min', () => {
    addRead()
    clock += 49 * HOUR
    start()
    expect(repo.search({ status: 'read' })).toHaveLength(0)
    expect(timers.map((t) => t.ms)).toEqual([60 * 60_000])
  })

  it('relit l’intervalle après chaque passe', () => {
    start()
    settings.set('cleanup_interval_min', 5)
    timers.at(-1)!.fn()
    expect(timers.at(-1)!.ms).toBe(5 * 60_000)
  })

  it('replanifie immédiatement quand l’intervalle change', () => {
    start()
    const first = timers[0]!
    settings.set('cleanup_interval_min', 10)
    expect(first.cleared).toBe(true)
    expect(timers.at(-1)!.ms).toBe(10 * 60_000)
    const n = timers.length
    settings.set('ttl_hours', 12)
    expect(timers).toHaveLength(n)
  })

  it('stop() annule le timer et les replanifications', () => {
    const { job } = start()
    const t = timers.at(-1)!
    job.stop()
    expect(t.cleared).toBe(true)
    const n = timers.length
    settings.set('cleanup_interval_min', 3)
    expect(timers).toHaveLength(n)
  })

  it('runOnce direct ne lève pas : log error et rapport à zéro', () => {
    const { job, log } = start()
    vi.spyOn(repo, 'deleteExpired').mockImplementation(() => {
      throw new Error('boom')
    })
    expect(job.runOnce()).toEqual({
      readDeleted: 0,
      pendingExpired: 0,
      oauthDeleted: 0,
      clientsDeleted: 0,
      sessionsDeleted: 0,
    })
    expect(log).toHaveBeenCalledWith('error', expect.any(String), { error: 'boom' })
  })

  it('une erreur est loguée et le timer continue', () => {
    const { log } = start()
    db.exec('DROP TABLE oauth_codes')
    timers.at(-1)!.fn()
    expect(log).toHaveBeenCalledWith('error', expect.any(String), expect.any(Object))
    expect(timers.at(-1)!.cleared).toBe(false)
    expect(timers.filter((t) => !t.cleared)).toHaveLength(1)
  })
})
