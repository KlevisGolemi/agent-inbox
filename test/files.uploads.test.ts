import { createHash } from 'node:crypto'
import fs, { readFileSync } from 'node:fs'
import { PassThrough, Readable } from 'node:stream'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb } from '../src/db/index.js'
import { migrate } from '../src/db/migrations.js'
import type { FileStore } from '../src/files/store.js'
import { UploadError, type UploadManager } from '../src/files/uploads.js'
import { createSettings, seedSettings, type Settings } from '../src/settings/index.js'
import {
  chunked,
  cleanupFixtures,
  filesFixture,
  finalFiles,
  PDF_MINI,
  PNG_1X1,
  sized,
  tempFiles,
} from './helpers/files.js'

const MB = 1024 * 1024
const GB = 1024 ** 3
let db: Database.Database
let settings: Settings
let store: FileStore
let uploads: UploadManager
let root: string

beforeEach(() => {
  db = openDb(':memory:')
  migrate(db, () => {})
  settings = createSettings(db)
  seedSettings(settings, db, {}, () => 'x'.repeat(64))
  ;({ store, uploads, root } = filesFixture(db, settings))
})
afterEach(cleanupFixtures)

/** Occupe le quota sauf `free` octets (ligne vivante factice). */
function fillQuota(free: number) {
  settings.set('storage_quota_gb', 0.1)
  db.prepare(
    `INSERT INTO messages (id, source, payload, status, created_at) VALUES ('m', 't', '{}', 'pending', 1)`,
  ).run()
  db.prepare(
    `INSERT INTO attachments (id, message_id, filename, mime_type, category, size_bytes, sha256, created_at, expires_at)
     VALUES ('00000000-0000-4000-8000-000000000000', 'm', 'f', 'application/pdf', 'document', ?, 'h', 1, 9e15)`,
  ).run(Math.floor(0.1 * GB) - free)
}

const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise
    return 'ok'
  } catch (error) {
    return error instanceof UploadError ? error.code : String(error)
  }
}

describe('UploadSession', () => {
  it('stage puis commit : fichier définitif, sha256, réservation libérée', async () => {
    const session = uploads.begin()
    const file = await session.stage(Readable.from([PDF_MINI]), '../devis.pdf')
    expect(file).toMatchObject({
      filename: 'devis.pdf',
      mime_type: 'application/pdf',
      category: 'document',
      size_bytes: PDF_MINI.length,
    })
    expect(file.sha256).toBe(createHash('sha256').update(PDF_MINI).digest('hex'))
    expect(uploads.reservedBytes()).toBe(PDF_MINI.length)
    const result = session.commit(() => ({ ok: true }))
    expect(result.ok).toBe(true)
    expect(readFileSync(store.path(file.id))).toEqual(PDF_MINI)
    expect(tempFiles(root)).toEqual([])
    expect(uploads.reservedBytes()).toBe(0)
  })

  it('commit {ok:false} ou qui lève : fichiers définitifs effacés', async () => {
    const first = uploads.begin()
    await first.stage(Readable.from([PDF_MINI]), 'a.pdf')
    expect(first.commit(() => ({ ok: false })).ok).toBe(false)
    const second = uploads.begin()
    await second.stage(Readable.from([PDF_MINI]), 'b.pdf')
    expect(() =>
      second.commit(() => {
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(finalFiles(root)).toEqual([])
    expect(uploads.reservedBytes()).toBe(0)
  })

  it('limite par catégorie : 413 file_too_large au fil de l’eau ; abort efface tout', async () => {
    settings.set('file_max_mb', {
      image: 1,
      audio: 50,
      video: 200,
      document: 50,
      archive: 500,
      other: 100,
    })
    const session = uploads.begin()
    expect(await codeOf(session.stage(chunked(sized(PNG_1X1, 2 * MB)), 'big.png'))).toBe(
      'file_too_large',
    )
    await session.abort()
    expect(tempFiles(root)).toEqual([])
    expect(uploads.reservedBytes()).toBe(0)
  })

  it('StageOptions.maxBytes (drop) plafonne en dessous de la catégorie', async () => {
    const session = uploads.begin()
    expect(
      await codeOf(session.stage(chunked(sized(PDF_MINI, 2 * MB)), 'a.pdf', { maxBytes: MB })),
    ).toBe('file_too_large')
    await session.abort()
  })

  it.each([
    [
      'extension bloquée',
      () => settings.set('file_blocked_extensions', ['pdf']),
      'extension_blocked',
    ],
    [
      'catégorie refusée',
      () => settings.set('file_allowed_categories', ['image']),
      'category_not_allowed',
    ],
    ['trop de fichiers', () => settings.set('attachments_max_per_message', 1), 'too_many_files'],
  ])('%s', async (_label, arrange, code) => {
    arrange()
    const session = uploads.begin()
    const first = await codeOf(session.stage(Readable.from([PDF_MINI]), 'a.pdf'))
    const second =
      code === 'too_many_files'
        ? await codeOf(session.stage(Readable.from([PDF_MINI]), 'b.pdf'))
        : first
    expect(second).toBe(code)
    await session.abort()
    expect(tempFiles(root)).toEqual([])
  })

  it('catégorie refusée par StageOptions.allowedCategories', async () => {
    const session = uploads.begin()
    expect(
      await codeOf(
        session.stage(Readable.from([PDF_MINI]), 'a.pdf', { allowedCategories: ['image'] }),
      ),
    ).toBe('category_not_allowed')
    await session.abort()
  })

  it('fichier vide refusé', async () => {
    const session = uploads.begin()
    expect(await codeOf(session.stage(Readable.from([]), 'vide.txt'))).toBe('empty_file')
    await session.abort()
  })

  it('attachments_enabled=false : begin refuse', () => {
    settings.set('attachments_enabled', false)
    expect(() => uploads.begin()).toThrow(expect.objectContaining({ code: 'attachments_disabled' }))
  })

  it('quota : 507 quota_exceeded sans résidu', async () => {
    fillQuota(1000)
    const session = uploads.begin()
    expect(await codeOf(session.stage(Readable.from([sized(PDF_MINI, 2000)]), 'a.pdf'))).toBe(
      'quota_exceeded',
    )
    await session.abort()
    expect(tempFiles(root)).toEqual([])
  })

  it('disque : 507 disk_full sous storage_min_free_gb (statfs simulé)', async () => {
    settings.set('storage_min_free_gb', 1000)
    const session = uploads.begin()
    expect(await codeOf(session.stage(Readable.from([PDF_MINI]), 'a.pdf'))).toBe('disk_full')
    await session.abort()
  })

  it('deux uploads concurrents : jamais au-delà du quota, un seul refusé', async () => {
    fillQuota(1000)
    const a = uploads.begin()
    const b = uploads.begin()
    const results = await Promise.all([
      codeOf(a.stage(chunked(sized(PDF_MINI, 600), 200), 'a.pdf')),
      codeOf(b.stage(chunked(sized(PDF_MINI, 600), 200), 'b.pdf')),
    ])
    expect(results.sort()).toEqual(['ok', 'quota_exceeded'])
    expect(uploads.reservedBytes()).toBeLessThanOrEqual(1000)
    await a.abort()
    await b.abort()
    expect(uploads.reservedBytes()).toBe(0)
    expect(tempFiles(root)).toEqual([])
  })

  it('écriture disque en vol pendant notre destroy : l’erreur métier (quota) reste celle renvoyée', async () => {
    fillQuota(300)
    // Retient le rappel de fs.write : l'écriture est « en vol » quand le quota est dépassé.
    const held: (() => void)[] = []
    const realWrite = fs.write
    const spy = vi.spyOn(fs, 'write').mockImplementation(((...args: unknown[]) => {
      const cb = args.pop() as (...r: unknown[]) => void
      ;(realWrite as (...a: unknown[]) => void)(...args, (...r: unknown[]) =>
        held.push(() => cb(...r)),
      )
    }) as typeof fs.write)
    try {
      async function* source() {
        yield sized(PDF_MINI, 200)
        while (held.length === 0) await new Promise((resolve) => setImmediate(resolve))
        // Libère le rappel APRÈS notre destroy() (synchrone dès la reprise) : Node le termine en ERR_STREAM_DESTROYED.
        setImmediate(() => held.splice(0).forEach((release) => release()))
        yield sized(PDF_MINI, 200)
      }
      const session = uploads.begin()
      expect(await codeOf(session.stage(source(), 'a.pdf'))).toBe('quota_exceeded')
      expect(uploads.reservedBytes()).toBe(0)
      expect(tempFiles(root)).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })

  it('shutdown interrompt un upload en cours, efface ses temporaires, puis refuse begin', async () => {
    const session = uploads.begin()
    const source = new PassThrough()
    source.write(PDF_MINI)
    const pending = codeOf(session.stage(source, 'lent.pdf'))
    await vi.waitFor(() => expect(uploads.reservedBytes()).toBeGreaterThan(0))
    await uploads.shutdown()
    expect(await pending).toBe('aborted')
    expect(tempFiles(root)).toEqual([])
    expect(uploads.reservedBytes()).toBe(0)
    expect(() => uploads.begin()).toThrow(expect.objectContaining({ code: 'shutting_down' }))
  })

  it('abort absorbe une erreur source tardive sans erreur non gérée', async () => {
    class LateErrorStream extends PassThrough {
      override destroy(error?: Error): this {
        const result = super.destroy(error)
        queueMicrotask(() => this.emit('error', new Error('erreur tardive')))
        return result
      }
    }
    const session = uploads.begin()
    const source = new LateErrorStream()
    source.write(PDF_MINI)
    const pending = codeOf(session.stage(source, 'lent.pdf'))
    await vi.waitFor(() => expect(uploads.reservedBytes()).toBeGreaterThan(0))
    await session.abort()
    expect(await pending).toBe('aborted')
    expect(tempFiles(root)).toEqual([])
  })

  it('lit statfs au plus une fois par mébioctet reçu', async () => {
    let calls = 0
    const fixture = filesFixture(db, settings)
    const manager = (await import('../src/files/uploads.js')).createUploadManager({
      store: fixture.store,
      settings,
      statfs: () => {
        calls++
        return { bavail: 1e12, bsize: 1 }
      },
    })
    const session = manager.begin()
    await session.stage(chunked(sized(PDF_MINI, 2 * MB), 128 * 1024), 'a.pdf')
    expect(calls).toBeLessThanOrEqual(3)
    await session.abort()
  })

  it('snapshot', () => {
    expect(uploads.snapshot()).toEqual({
      used_bytes: 0,
      reserved_bytes: 0,
      quota_bytes: Math.floor(5 * GB),
      disk_free_bytes: 1e12,
      min_free_bytes: Math.floor(2 * GB),
      files_count: 0,
      accepting: true,
    })
  })
})
