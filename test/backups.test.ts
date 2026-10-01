import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SESSION_COOKIE } from '../src/auth/sessions.js'
import { createBackups, type Backups } from '../src/backups/index.js'
import { openDb } from '../src/db/index.js'
import { migrate } from '../src/db/migrations.js'
import { startBackups } from '../src/jobs/backup.js'
import { createSettings, seedSettings, type Settings } from '../src/settings/index.js'
import { makeTestApp } from './helpers/app.js'

const HOUR = 3_600_000
let db: Database.Database
let settings: Settings
let dir: string
let clock: number
let backups: Backups

const addMsg = (id: string) =>
  db
    .prepare("INSERT INTO messages (id, source, payload, status, created_at) VALUES (?, 't', '{}', 'pending', 1)")
    .run(id)
const ids = () => (db.prepare('SELECT id FROM messages ORDER BY id').all() as { id: string }[]).map((r) => r.id)

beforeEach(() => {
  db = openDb(':memory:')
  migrate(db, () => {})
  settings = createSettings(db)
  seedSettings(settings, db, {}, () => 'x'.repeat(64))
  dir = mkdtempSync(join(tmpdir(), 'cq-bk-'))
  clock = Date.UTC(2026, 0, 2, 3, 4, 5)
  backups = createBackups({ db, dir, settings, now: () => clock })
})

describe('sauvegardes', () => {
  it('crée une sauvegarde nommée en UTC et la liste', async () => {
    const b = await backups.run()
    expect(b.name).toBe('queue-20260102-030405.db')
    expect(b.size).toBeGreaterThan(0)
    expect(b.created_at).toBe('2026-01-02T03:04:05.000Z')
    expect(backups.list().map((x) => x.name)).toEqual([b.name])
  })

  it('ajoute un suffixe quand deux sauvegardes tombent dans la même seconde', async () => {
    const a = await backups.run()
    const b = await backups.run()
    const c = await backups.run()
    expect([a.name, b.name, c.name]).toEqual([
      'queue-20260102-030405.db',
      'queue-20260102-030405-2.db',
      'queue-20260102-030405-3.db',
    ])
    expect(backups.list().map((x) => x.name)).toEqual([c.name, b.name, a.name])
  })

  it('rétention 2 : la plus ancienne est supprimée', async () => {
    settings.set('backup_retention', 2)
    const first = await backups.run()
    clock += 1000
    await backups.run()
    clock += 1000
    const third = await backups.run()
    const names = backups.list().map((x) => x.name)
    expect(names).toHaveLength(2)
    expect(names).not.toContain(first.name)
    expect(names[0]).toBe(third.name)
    expect(readdirSync(dir)).toHaveLength(2)
  })

  it('restaure les données de la sauvegarde et laisse une sauvegarde préalable', async () => {
    addMsg('a')
    const b = await backups.run()
    addMsg('b')
    clock += 1000
    await backups.restore(b.name)
    expect(ids()).toEqual(['a'])
    // sauvegarde de sécurité contenant l'état d'avant (a et b)
    expect(backups.list()).toHaveLength(2)
    const safety = backups.list()[0]!
    const copy = new Database(backups.path(safety.name)!, { readonly: true })
    expect(copy.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 2 })
    copy.close()
  })

  it('la restauration invalide le cache des réglages', async () => {
    settings.set('ttl_hours', 10)
    const b = await backups.run()
    settings.set('ttl_hours', 99)
    expect(settings.get('ttl_hours')).toBe(99)
    await backups.restore(b.name)
    expect(settings.get('ttl_hours')).toBe(10)
  })

  it('rejette une sauvegarde dont le user_version diffère, sans rien modifier', async () => {
    addMsg('a')
    const b = await backups.run()
    const raw = new Database(backups.path(b.name)!)
    raw.pragma('user_version = 1')
    raw.close()
    addMsg('b')
    await expect(backups.restore(b.name)).rejects.toMatchObject({ code: 'incompatible_backup' })
    expect(ids()).toEqual(['a', 'b'])
    expect(backups.list()).toHaveLength(1)
  })

  it('refuse un nom invalide ou inconnu', async () => {
    expect(backups.path('../evil')).toBeNull()
    expect(backups.path('queue-20260101-000000.db')).toBeNull()
    await expect(backups.restore('../evil')).rejects.toMatchObject({ code: 'invalid_name' })
    await expect(backups.restore('queue-20260101-000000.db')).rejects.toMatchObject({
      code: 'not_found',
    })
  })
})

describe('planification', () => {
  let timers: { fn: () => void; ms: number; cleared: boolean }[]
  const setTimer = ((fn: () => void, ms: number) => {
    const t = { fn, ms, cleared: false }
    timers.push(t)
    return t
  }) as unknown as typeof setTimeout
  const clearTimer = ((t: { cleared: boolean }) => {
    t.cleared = true
  }) as unknown as typeof clearTimeout
  const live = () => timers.filter((t) => !t.cleared)

  beforeEach(() => {
    timers = []
  })

  it('programme la première exécution après un intervalle, pas au démarrage', () => {
    const run = vi.fn()
    startBackups({ backups: { run } as unknown as Backups, settings, setTimer, clearTimer })
    expect(run).not.toHaveBeenCalled()
    expect(live()).toHaveLength(1)
    expect(live()[0]!.ms).toBe(24 * HOUR)
  })

  it('intervalle 0 : aucun minuteur ; réactivé à chaud par un changement de réglage', () => {
    settings.set('backup_interval_hours', 0)
    startBackups({ backups: { run: vi.fn() } as unknown as Backups, settings, setTimer, clearTimer })
    expect(live()).toHaveLength(0)
    settings.set('backup_interval_hours', 6)
    expect(live()).toHaveLength(1)
    expect(live()[0]!.ms).toBe(6 * HOUR)
    settings.set('backup_interval_hours', 0)
    expect(live()).toHaveLength(0)
  })

  it('exécute, replanifie avec l’intervalle courant et survit à une erreur', async () => {
    const log = vi.fn()
    const run = vi.fn().mockRejectedValueOnce(new Error('disque plein')).mockResolvedValue({ name: 'n', size: 1 })
    startBackups({ backups: { run } as unknown as Backups, settings, log, setTimer, clearTimer })
    settings.set('backup_interval_hours', 12)
    live()[0]!.fn()
    await vi.waitFor(() => expect(live()).toHaveLength(1))
    expect(log).toHaveBeenCalledWith('error', 'Échec de la sauvegarde', { error: 'disque plein' })
    expect(live()[0]!.ms).toBe(12 * HOUR)
  })

  it('stop() annule le minuteur', () => {
    const job = startBackups({ backups: { run: vi.fn() } as unknown as Backups, settings, setTimer, clearTimer })
    job.stop()
    expect(live()).toHaveLength(0)
  })
})

describe('API d’administration', () => {
  async function setup() {
    const ctx = makeTestApp()
    const user = await ctx.users.create('admin@example.test', 'mot-de-passe-initial-1')
    const base = `${SESSION_COOKIE}=${ctx.sessions.create(user.id)}`
    const csrf = (await request(ctx.app).get('/admin/api/overview').set('Cookie', base)).body
      .csrfToken as string
    const cookies = `${base}; cq_csrf=${csrf}`
    const api = (m: 'get' | 'post', path: string) =>
      request(ctx.app)[m](`/admin/api${path}`).set('Cookie', cookies).set('x-csrf-token', csrf)
    return { ...ctx, api }
  }

  it('crée, liste et télécharge une sauvegarde', async () => {
    const { api } = await setup()
    const created = await api('post', '/backups')
    expect(created.status).toBe(201)
    const name = created.body.backup.name as string
    const list = await api('get', '/backups')
    expect(list.body.backups.map((b: { name: string }) => b.name)).toEqual([name])
    const dl = await api('get', `/backups/${name}/download`)
    expect(dl.status).toBe(200)
    expect(dl.headers['content-disposition']).toContain(`attachment; filename="${name}"`)
    expect(dl.headers['cache-control']).toBe('no-store')
  })

  it('restaure avec confirm:true, refuse sans confirmation', async () => {
    const { api, db: appDb } = await setup()
    const name = (await api('post', '/backups')).body.backup.name as string
    appDb.prepare("INSERT INTO messages (id, source, payload, status, created_at) VALUES ('z','t','{}','pending',1)").run()
    expect((await api('post', `/backups/${name}/restore`).send({})).status).toBe(400)
    expect(appDb.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 1 })
    const ok = await api('post', `/backups/${name}/restore`).send({ confirm: true })
    expect(ok.status).toBe(200)
    expect(appDb.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 0 })
  })

  it('renvoie 400 invalid_name pour un nom hors format et 404 pour un inconnu', async () => {
    const { api } = await setup()
    for (const bad of ['..%2Fevil', 'evil.db', 'queue-1.db']) {
      const d = await api('get', `/backups/${bad}/download`)
      expect(d.status).toBe(400)
      expect(d.body.error).toBe('invalid_name')
      const r = await api('post', `/backups/${bad}/restore`).send({ confirm: true })
      expect(r.status).toBe(400)
    }
    expect((await api('get', '/backups/queue-20200101-000000.db/download')).status).toBe(404)
  })
})
