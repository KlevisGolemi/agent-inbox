import { Writable } from 'node:stream'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** Simulations d'erreurs disque : createWriteStream et statSync sont substituables par test. */
const sim = vi.hoisted(() => ({
  writeError: null as null | { code: string; when: 'open' | 'write' | 'final' },
  statEnoent: false,
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    createWriteStream: ((path: string, options: object) => {
      const failure = sim.writeError
      if (!failure) return actual.createWriteStream(path as never, options as never)
      const fail = (cb: (error?: Error | null) => void) =>
        cb(
          Object.assign(new Error(`${failure.code}: erreur simulée, write '${path}'`), {
            code: failure.code,
          }),
        )
      return new Writable({
        construct(cb) {
          if (failure.when === 'open') setImmediate(() => fail(cb))
          else cb()
        },
        write(_chunk, _enc, cb) {
          if (failure.when === 'write') fail(cb)
          else cb()
        },
        final(cb) {
          fail(cb)
        },
      })
    }) as typeof actual.createWriteStream,
    statSync: ((path: string, ...rest: unknown[]) => {
      if (sim.statEnoent) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
      return (actual.statSync as (...args: unknown[]) => unknown)(path, ...rest)
    }) as typeof actual.statSync,
  }
})

import { rmSync, writeFileSync } from 'node:fs'
import { openDb } from '../src/db/index.js'
import { migrate } from '../src/db/migrations.js'
import type { FileStore } from '../src/files/store.js'
import { UploadError, type UploadManager } from '../src/files/uploads.js'
import { createSettings, seedSettings, type Settings } from '../src/settings/index.js'
import {
  chunked,
  cleanupFixtures,
  filesFixture,
  PDF_MINI,
  sized,
  tempFiles,
} from './helpers/files.js'

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
afterEach(() => {
  sim.writeError = null
  sim.statEnoent = false
  cleanupFixtures()
})

const outcome = async (promise: Promise<unknown>) => {
  try {
    await promise
    return null
  } catch (error) {
    return error as Error
  }
}

describe('erreurs du flux de sortie (jamais de blocage)', () => {
  it.each(['open', 'write', 'final'] as const)(
    'ENOSPC pendant %s : disk_full, réservation libérée, zéro résidu',
    async (when) => {
      sim.writeError = { code: 'ENOSPC', when }
      const session = uploads.begin()
      const error = await outcome(
        session.stage(chunked(sized(PDF_MINI, 300 * 1024), 64 * 1024), 'a.pdf'),
      )
      expect(error).toBeInstanceOf(UploadError)
      expect((error as UploadError).code).toBe('disk_full')
      expect(error?.message).not.toContain(root)
      expect(uploads.reservedBytes()).toBe(0)
      expect(tempFiles(root)).toEqual([])
      await session.abort()
      await uploads.shutdown()
    },
    3000,
  )

  it('ENOSPC à l’ouverture, petit fichier en un bloc : pas de blocage sur finish', async () => {
    sim.writeError = { code: 'ENOSPC', when: 'open' }
    const session = uploads.begin()
    const error = await outcome(session.stage(chunked(PDF_MINI), 'a.pdf'))
    expect((error as UploadError).code).toBe('disk_full')
    expect(uploads.reservedBytes()).toBe(0)
    expect(tempFiles(root)).toEqual([])
    await uploads.shutdown()
  }, 3000)

  it('erreur déjà émise avant le bloc suivant (petits blocs) : pas d’attente de drain', async () => {
    sim.writeError = { code: 'ENOSPC', when: 'write' }
    const session = uploads.begin()
    const error = await outcome(session.stage(chunked(sized(PDF_MINI, 64 * 1024), 1024), 'a.pdf'))
    expect((error as UploadError).code).toBe('disk_full')
    expect(uploads.reservedBytes()).toBe(0)
    await uploads.shutdown()
  }, 3000)

  it('erreur émise avant la fin de la source : pas d’attente de finish', async () => {
    sim.writeError = { code: 'ENOSPC', when: 'open' }
    const session = uploads.begin()
    const slowEnd = (async function* () {
      yield PDF_MINI
      await new Promise((resolve) => setTimeout(resolve, 30))
    })()
    const error = await outcome(session.stage(slowEnd, 'a.pdf'))
    expect((error as UploadError).code).toBe('disk_full')
    expect(uploads.reservedBytes()).toBe(0)
    await uploads.shutdown()
  }, 3000)

  it('autre erreur disque : message sans chemin', async () => {
    sim.writeError = { code: 'EIO', when: 'write' }
    const session = uploads.begin()
    const error = await outcome(
      session.stage(chunked(sized(PDF_MINI, 300 * 1024), 64 * 1024), 'a.pdf'),
    )
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(UploadError)
    expect(error?.message).not.toContain(root)
    expect(error?.message).not.toContain('.tmp')
    expect(uploads.reservedBytes()).toBe(0)
    await session.abort()
  }, 3000)

  it('dossier .tmp supprimé (vrai flux en erreur) : stage rejette, abort et shutdown terminent', async () => {
    sim.writeError = null
    rmSync(`${root}/.tmp`, { recursive: true, force: true })
    const session = uploads.begin()
    const error = await outcome(
      session.stage(chunked(sized(PDF_MINI, 300 * 1024), 64 * 1024), 'a.pdf'),
    )
    expect(error).toBeInstanceOf(Error)
    expect(error?.message).not.toContain(root)
    expect(uploads.reservedBytes()).toBe(0)
    await session.abort()
    await uploads.shutdown()
  }, 3000)

  it('dossier .tmp supprimé, petit fichier en un seul bloc : pas de blocage sur finish', async () => {
    rmSync(`${root}/.tmp`, { recursive: true, force: true })
    const session = uploads.begin()
    const error = await outcome(session.stage(chunked(PDF_MINI), 'a.pdf'))
    expect(error).toBeInstanceOf(Error)
    expect(uploads.reservedBytes()).toBe(0)
    await uploads.shutdown()
  }, 3000)
})

describe('snapshot', () => {
  it('reflète les pièces vivantes sans begin() préalable', () => {
    db.prepare(
      `INSERT INTO messages (id, source, payload, status, created_at) VALUES ('m', 't', '{}', 'pending', 1)`,
    ).run()
    db.prepare(
      `INSERT INTO attachments (id, message_id, filename, mime_type, category, size_bytes, sha256, created_at, expires_at)
       VALUES ('00000000-0000-4000-8000-000000000000', 'm', 'f', 'application/pdf', 'document', 1234, 'h', 1, 9e15)`,
    ).run()
    expect(uploads.snapshot()).toMatchObject({ used_bytes: 1234, files_count: 1 })
    db.prepare('DELETE FROM attachments').run()
    expect(uploads.snapshot()).toMatchObject({ used_bytes: 0, files_count: 0 })
  })
})

describe('FileStore.listTemp', () => {
  it('ignore un temporaire supprimé entre readdir et stat (ENOENT)', () => {
    writeFileSync(store.tempPath(store.newTempId()), 't')
    sim.statEnoent = true
    expect(store.listTemp()).toEqual([])
  })
})
