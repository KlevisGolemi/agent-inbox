import { existsSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import type Database from 'better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb } from '../src/db/index.js'
import { migrate } from '../src/db/migrations.js'
import { newAttachments } from '../src/files/attachments.js'
import type { FileStore } from '../src/files/store.js'
import type { UploadManager } from '../src/files/uploads.js'
import { startCleanup } from '../src/jobs/cleanup.js'
import { createQueueRepo, type QueueRepo } from '../src/queue/repo.js'
import { createSettings, seedSettings, type Settings } from '../src/settings/index.js'
import { filesFixture, finalFiles, PDF_MINI, tempFiles } from './helpers/files.js'

const HOUR = 3_600_000
let db: Database.Database
let settings: Settings
let store: FileStore
let uploads: UploadManager
let root: string
let repo: QueueRepo
let clock: number

beforeEach(() => {
  db = openDb(':memory:')
  migrate(db, () => {})
  settings = createSettings(db)
  seedSettings(settings, db, {}, () => 'x'.repeat(64))
  ;({ store, uploads, root } = filesFixture(db, settings))
  clock = Date.now()
  repo = createQueueRepo(db, { now: () => clock, files: store, settings })
})

/** startCleanup exécute une passe à sa création : on le crée AVANT de préparer l'état à nettoyer. */
const job = () =>
  startCleanup({
    db,
    repo,
    settings,
    files: store,
    uploads,
    log: () => {},
    now: () => clock,
    setTimer: (() => 0) as unknown as typeof setTimeout,
    clearTimer: (() => {}) as unknown as typeof clearTimeout,
  })

async function addMessageWithPdf(onDownload: 'keep' | 'consume' = 'keep') {
  const s = uploads.begin()
  await s.stage(Readable.from([PDF_MINI]), 'f.pdf')
  const r = s.commit((f) =>
    repo.enqueue({
      payload: {},
      source: 't',
      correlationId: null,
      attachments: newAttachments(f, onDownload, settings, clock),
    }),
  )
  if (!r.ok) throw new Error('attendu ok')
  return r.id
}

describe('nettoyage des fichiers', () => {
  it('un message lu au-delà du TTL reste tant que sa pièce est vivante, puis part avec elle', async () => {
    const id = await addMessageWithPdf()
    repo.claimNext()
    const j = job()
    clock += 49 * HOUR // TTL messages 48 h, pièce document 72 h
    expect(j.runOnce()).toMatchObject({ readDeleted: 0, filesExpired: 0 })
    expect(repo.findById(id)).not.toBeNull()
    clock += 24 * HOUR
    expect(j.runOnce()).toMatchObject({ readDeleted: 1, filesExpired: 1 })
    expect(finalFiles(root)).toEqual([])
    j.stop()
  })

  it('consume : effacé après consume_grace_min suivant la première livraison', async () => {
    const id = await addMessageWithPdf('consume')
    const att = repo.findById(id)!.attachments[0]!.id
    db.prepare('UPDATE attachments SET first_downloaded_at = ? WHERE id = ?').run(clock, att)
    const j = job()
    clock += 5 * 60_000
    expect(j.runOnce().filesConsumed).toBe(0)
    clock += 6 * 60_000
    expect(j.runOnce().filesConsumed).toBe(1)
    expect(db.prepare('SELECT deleted_reason FROM attachments').get()).toEqual({
      deleted_reason: 'consumed',
    })
    expect(finalFiles(root)).toEqual([])
    j.stop()
  })

  it('orphelins et temporaires de plus d’une heure effacés ; temporaire d’un upload en cours conservé', async () => {
    const j = job()
    const orphan = store.newTempId()
    writeFileSync(join(root, orphan), 'x')
    const stale = store.newTempId()
    writeFileSync(store.tempPath(stale), 'x')
    const old = (Date.now() - 2 * HOUR) / 1000
    utimesSync(store.tempPath(stale), old, old)
    const s = uploads.begin()
    const src = new PassThrough()
    src.write(PDF_MINI)
    const pending = s.stage(src, 'lent.pdf').catch(() => undefined)
    const active = [...uploads.activeTempIds()][0]!
    await vi.waitFor(() => expect(existsSync(store.tempPath(active))).toBe(true))
    utimesSync(store.tempPath(active), old, old)
    expect(j.runOnce()).toMatchObject({ orphansDeleted: 1, tempsDeleted: 1 })
    expect(tempFiles(root)).toEqual([active])
    await s.abort()
    await pending
    j.stop()
  })
})
