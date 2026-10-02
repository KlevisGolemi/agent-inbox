import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db/index.js'
import { migrate } from '../src/db/migrations.js'
import { computeExpiresAt } from '../src/files/retention.js'
import type { FileStore } from '../src/files/store.js'
import { createSettings, seedSettings, type Settings } from '../src/settings/index.js'
import { cleanupFixtures, filesFixture, finalFiles, tempFiles } from './helpers/files.js'

const HOUR = 3_600_000
const MB = 1024 * 1024
let db: Database.Database
let settings: Settings
let store: FileStore
let root: string

beforeEach(() => {
  db = openDb(':memory:')
  migrate(db, () => {})
  settings = createSettings(db)
  seedSettings(settings, db, {}, () => 'x'.repeat(64))
  ;({ store, root } = filesFixture(db, settings))
})
afterEach(cleanupFixtures)

function insertAttachment(id: string, size: number, deleted = false) {
  db.prepare(`INSERT OR IGNORE INTO messages (id, source, payload, status, created_at) VALUES ('m', 't', '{}', 'pending', 1)`).run()
  db.prepare(
    `INSERT INTO attachments (id, message_id, filename, mime_type, category, size_bytes, sha256, created_at, expires_at, deleted_at)
     VALUES (?, 'm', 'f', 'application/pdf', 'document', ?, 'h', 1, 2, ?)`,
  ).run(id, size, deleted ? 5 : null)
}

describe('computeExpiresAt', () => {
  it('par catégorie, ramené à file_retention_large_hours au-delà de file_retention_large_mb', () => {
    const time = 1_000
    expect(computeExpiresAt({ createdAt: time, category: 'image', sizeBytes: MB }, settings)).toBe(time + 168 * HOUR)
    expect(computeExpiresAt({ createdAt: time, category: 'image', sizeBytes: 60 * MB }, settings)).toBe(time + 24 * HOUR)
    expect(computeExpiresAt({ createdAt: time, category: 'video', sizeBytes: MB }, settings)).toBe(time + 24 * HOUR)
    settings.set('file_retention_large_hours', 12)
    expect(computeExpiresAt({ createdAt: time, category: 'image', sizeBytes: 60 * MB }, settings)).toBe(time + 12 * HOUR)
  })
})

describe('FileStore', () => {
  it('crée root et .tmp ; refuse un identifiant qui n’est pas un uuid', () => {
    expect(existsSync(store.tmpDir)).toBe(true)
    expect(() => store.path('../x')).toThrow(/invalide/)
    expect(store.has('../x')).toBe(false)
  })

  it('promote renomme tout, ou rien si un fichier manque', () => {
    const a = store.newTempId()
    const b = store.newTempId()
    writeFileSync(store.tempPath(a), 'a')
    expect(() => store.promote([a, b])).toThrow()
    expect(finalFiles(root)).toEqual([])
    expect(tempFiles(root)).toEqual([a])
    writeFileSync(store.tempPath(b), 'b')
    store.promote([a, b])
    expect(finalFiles(root).sort()).toEqual([a, b].sort())
    expect(tempFiles(root)).toEqual([])
  })

  it('unlinkFinal / unlinkTemp ignorent les fichiers absents et comptent les effacés', () => {
    const a = store.newTempId()
    writeFileSync(store.tempPath(a), 'a')
    store.promote([a])
    expect(store.unlinkFinal([a, store.newTempId()])).toBe(1)
    const temp = store.newTempId()
    writeFileSync(store.tempPath(temp), 't')
    expect(store.unlinkTemp([temp])).toBe(1)
    expect(finalFiles(root)).toEqual([])
  })

  it('usedBytes et liveCount ne comptent que les pièces vivantes', () => {
    insertAttachment('11111111-1111-4111-8111-111111111111', 100)
    insertAttachment('22222222-2222-4222-8222-222222222222', 50, true)
    expect(store.usedBytes()).toBe(100)
    expect(store.liveCount()).toBe(1)
  })

  it('listFinal ignore les noms qui ne sont pas des uuid ; listTemp donne mtimeMs', () => {
    writeFileSync(join(root, 'notes.txt'), 'x')
    const temp = store.newTempId()
    writeFileSync(store.tempPath(temp), 't')
    expect(store.listFinal()).toEqual([])
    expect(store.listTemp()).toEqual([{ id: temp, mtimeMs: expect.any(Number) }])
  })
})
