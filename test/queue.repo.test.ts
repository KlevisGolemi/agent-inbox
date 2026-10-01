import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db/index.js'
import { migrate } from '../src/db/migrations.js'
import { createQueueRepo, type QueueRepo } from '../src/queue/repo.js'

const quiet = () => {}
let db: Database.Database
let clock: number
let repo: QueueRepo

const add = (
  n: number,
  extra: { topic?: string; correlationId?: string | null; source?: string } = {},
) =>
  repo.enqueue({
    payload: { n },
    source: extra.source ?? 't',
    correlationId: extra.correlationId ?? null,
    ...(extra.topic ? { topic: extra.topic } : {}),
  })

beforeEach(() => {
  db = openDb(':memory:')
  migrate(db, quiet)
  clock = 1_000_000
  repo = createQueueRepo(db, { now: () => clock, leaseTimeoutMs: () => 60_000 })
})

describe('file FIFO', () => {
  it("sert les messages dans l'ordre et les marque lus", () => {
    add(1)
    clock += 10
    add(2)
    const a = repo.claimNext()!
    expect(a.payload).toEqual({ n: 1 })
    expect(a.status).toBe('read')
    expect(a.read_at).toBe(new Date(clock).toISOString())
    expect(repo.claimNext()!.payload).toEqual({ n: 2 })
    expect(repo.claimNext()).toBeNull()
  })

  it("refuse un correlation_id en double et renvoie l'id existant", () => {
    const first = add(1, { correlationId: 'abc' })
    const second = add(2, { correlationId: 'abc' })
    expect(first.ok).toBe(true)
    expect(second).toEqual({
      ok: false,
      error: 'duplicate_correlation_id',
      existingId: first.ok ? first.id : null,
    })
  })

  it('renvoie le nombre de messages en attente', () => {
    add(1)
    const r = add(2)
    expect(r.ok && r.pending).toBe(2)
  })

  it('distingue not_found et already_read', () => {
    add(1, { correlationId: 'c1' })
    expect(repo.claimByCorrelation('zzz')).toEqual({ error: 'not_found' })
    const ok = repo.claimByCorrelation('c1')
    expect('item' in ok && ok.item.status).toBe('read')
    const again = repo.claimByCorrelation('c1')
    expect(again).toMatchObject({ error: 'already_read' })
    expect('read_at' in again && again.read_at).toBe(new Date(clock).toISOString())
  })

  it('findByCorrelation ne consomme pas', () => {
    add(1, { correlationId: 'c1' })
    expect(repo.findByCorrelation('c1')!.status).toBe('pending')
    expect(repo.findByCorrelation('nope')).toBeNull()
    expect(repo.stats().pending).toBe(1)
  })

  it('pagine peek du plus récent au plus ancien', () => {
    for (let i = 0; i < 5; i++) {
      add(i)
      clock += 1
    }
    expect(repo.peek(2, 0).map((m) => (m.payload as { n: number }).n)).toEqual([4, 3])
    expect(repo.peek(2, 2).map((m) => (m.payload as { n: number }).n)).toEqual([2, 1])
  })

  it('renvoie un payload corrompu brut', () => {
    db.prepare(
      `INSERT INTO messages (id, source, payload, status, created_at) VALUES ('x','s','{oops','pending',1)`,
    ).run()
    expect(repo.peek(10, 0)[0]!.payload).toEqual({ __corrupted: true, raw: '{oops' })
  })

  it('supprime par id et vide la file', () => {
    const r = add(1)
    add(2)
    expect(repo.deleteById(r.ok ? r.id : '')).toBe(true)
    expect(repo.deleteById('inconnu')).toBe(false)
    expect(repo.clear()).toBe(1)
    expect(repo.stats().total).toBe(0)
  })

  it('deux connexions qui consomment en parallèle ne reçoivent jamais le même message', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'cq-')), 'q.db')
    const a = openDb(file)
    migrate(a, quiet)
    const b = openDb(file)
    const ra = createQueueRepo(a)
    const rb = createQueueRepo(b)
    for (let i = 0; i < 50; i++) ra.enqueue({ payload: { i }, source: 't', correlationId: null })
    const seen = new Set<string>()
    for (let i = 0; i < 25; i++)
      for (const r of [ra, rb]) {
        const m = r.claimNext()
        expect(m).not.toBeNull()
        expect(seen.has(m!.id)).toBe(false)
        seen.add(m!.id)
      }
    expect(ra.claimNext()).toBeNull()
    a.close()
    b.close()
  })
})

describe('topics', () => {
  it("le filtre topic n'emprunte jamais un autre topic", () => {
    add(1, { topic: 'a' })
    add(2, { topic: 'b' })
    expect(repo.claimNext({ topic: 'c' })).toBeNull()
    expect(repo.claimNext({ topic: 'b' })!.payload).toEqual({ n: 2 })
    expect(repo.claimNext({ topic: 'b' })).toBeNull()
    expect(repo.claimNext({ topic: 'a' })!.topic).toBe('a')
  })

  it('utilise le topic default par défaut et sert tous les topics sans filtre', () => {
    add(1)
    add(2, { topic: 'x' })
    expect(repo.peek(10, 0, { topic: 'default' })).toHaveLength(1)
    expect(repo.peek(10, 0)).toHaveLength(2)
  })

  it('compte par topic dans stats', () => {
    add(1)
    add(2, { topic: 'x' })
    add(3, { topic: 'x' })
    expect(repo.stats().topics).toEqual({ default: 1, x: 2 })
    expect(repo.stats({ topic: 'x' })).toMatchObject({ total: 2, pending: 2, topics: { x: 2 } })
  })
})

describe('bail, ack, nack', () => {
  it('emprunte puis re-sert un bail expiré avec attempts 2', () => {
    add(1)
    const first = repo.claimNext({ lease: true })!
    expect(first.status).toBe('leased')
    expect(first.attempts).toBe(1)
    expect(first.lease_until).toBe(new Date(clock + 60_000).toISOString())
    expect(first.read_at).toBeNull()
    expect(repo.claimNext({ lease: true })).toBeNull()
    clock += 60_001
    const second = repo.claimNext({ lease: true })!
    expect(second.id).toBe(first.id)
    expect(second.attempts).toBe(2)
  })

  it('ack passe le message à read ; ack/nack inconnus, invalides ou non empruntés', () => {
    const r = add(1)
    const id = r.ok ? r.id : ''
    expect(repo.ack(`${id}.1`)).toBe('not_leased')
    expect(repo.nack(`${id}.1`)).toBe('not_leased')
    expect(repo.ack('inconnu.1')).toBe('not_found')
    expect(repo.ack('inconnu')).toBe('invalid_lease')
    expect(repo.nack(`${id}.x`)).toBe('invalid_lease')
    const m = repo.claimNext({ lease: true })!
    expect(m.lease_id).toBe(`${id}.1`)
    expect(repo.ack(m.lease_id!)).toBe('ok')
    expect(repo.stats()).toMatchObject({ read_count: 1, leased: 0, pending: 0 })
    expect(repo.ack(m.lease_id!)).toBe('not_leased')
  })

  it('nack remet en attente en conservant attempts', () => {
    add(1)
    const m = repo.claimNext({ lease: true })!
    expect(repo.nack(m.lease_id!)).toBe('ok')
    const p = repo.peek(1, 0)[0]!
    expect(p).toMatchObject({ status: 'pending', lease_until: null, lease_id: null, attempts: 1 })
    expect(repo.claimNext({ lease: true })!.attempts).toBe(2)
  })

  it('un bail dépassé par un nouvel emprunt ne peut plus être acquitté', () => {
    add(1)
    const first = repo.claimNext({ lease: true })!
    clock += 60_001
    const second = repo.claimNext({ lease: true })!
    expect(second.lease_id).toBe(`${first.id}.2`)
    expect(repo.ack(first.lease_id!)).toBe('not_leased')
    expect(repo.nack(first.lease_id!)).toBe('not_leased')
    expect(repo.stats().leased).toBe(1)
    expect(repo.ack(second.lease_id!)).toBe('ok')
  })

  it('un bail expiré mais non ré-emprunté peut encore être acquitté', () => {
    add(1)
    const m = repo.claimNext({ lease: true })!
    clock += 120_000
    expect(repo.ack(m.lease_id!)).toBe('ok')
  })

  it('claimByCorrelation : leased non expiré → leased, expiré → re-servi', () => {
    add(1, { correlationId: 'c' })
    expect('item' in repo.claimByCorrelation('c', { lease: true })).toBe(true)
    expect(repo.claimByCorrelation('c')).toEqual({
      error: 'leased',
      lease_until: new Date(clock + 60_000).toISOString(),
    })
    clock += 60_001
    const again = repo.claimByCorrelation('c', { lease: true })
    expect('item' in again && again.item.attempts).toBe(2)
  })
})

describe('search', () => {
  beforeEach(() => {
    add(1, { source: 'alpha', topic: 'a' })
    clock += 1000
    add(2, { source: 'beta', topic: 'b' })
    clock += 1000
    repo.enqueue({
      payload: { msg: '100% sûr_ok' },
      source: 'alpha',
      correlationId: null,
      topic: 'a',
    })
    repo.claimNext({ topic: 'b' })
  })

  it('filtre par topic, source, status', () => {
    expect(repo.search({ topic: 'a' })).toHaveLength(2)
    expect(repo.search({ source: 'beta' })).toHaveLength(1)
    expect(repo.search({ status: 'read' }).map((m) => m.topic)).toEqual(['b'])
  })

  it('filtre par since/until et limite, du plus récent au plus ancien', () => {
    expect(repo.search({ since: 1_001_000, until: 1_001_000 })).toHaveLength(1)
    expect(repo.search({ limit: 1 })).toHaveLength(1)
    expect(repo.search({})[0]!.created_at > repo.search({})[2]!.created_at).toBe(true)
  })

  it('text : LIKE avec % et _ échappés', () => {
    expect(repo.search({ text: '100%' })).toHaveLength(1)
    expect(repo.search({ text: 'sûr_ok' })).toHaveLength(1)
    expect(repo.search({ text: 'sûrXok' })).toHaveLength(0)
    expect(repo.search({ text: '%' })).toHaveLength(1)
  })
})

describe('expiration', () => {
  const H = 3_600_000
  it('supprime lus et non lus anciens, avec surcharge par topic', () => {
    const t0 = 100 * H
    clock = 0
    add(1) // default, vieux
    add(2, { topic: 'long' }) // vieux mais surchargé à 100 h
    repo.claimNext({ topic: 'default' }) // lu à t=0
    add(3, { topic: 'long' })
    clock = t0
    add(4) // récent
    const res = repo.deleteExpired(t0 - 48 * H, { long: 100 }, t0)
    expect(res).toEqual({ read: 1, pending: 0 })
    expect(repo.stats().total).toBe(3)
    const res2 = repo.deleteExpired(t0 - 48 * H, { long: 5 }, t0)
    expect(res2).toEqual({ read: 0, pending: 2 })
    expect(repo.stats().total).toBe(1)
  })

  it('compte un message emprunté comme non lu', () => {
    clock = 0
    add(1)
    repo.claimNext({ lease: true })
    expect(repo.deleteExpired(10, {}, 20)).toEqual({ read: 0, pending: 1 })
  })
})

describe('onEnqueue', () => {
  it('notifie puis se désabonne', () => {
    const seen: string[] = []
    const off = repo.onEnqueue((m) => seen.push(m.topic))
    add(1, { topic: 'x' })
    off()
    add(2)
    expect(seen).toEqual(['x'])
  })
})
