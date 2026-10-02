import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { createFileStore } from '../../src/files/store.js'
import { createUploadManager, type StatFs } from '../../src/files/uploads.js'
import type { Settings } from '../../src/settings/index.js'

/** PNG 1×1 valide. */
export const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)
export const PDF_MINI = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n')
export const SVG_ACTIVE = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
)
export const HTML_PAGE = Buffer.from('<!doctype html><html><body><script>alert(1)</script></body></html>')

/** Tampon de `size` octets commençant par `head` (signature conservée). */
export function sized(head: Buffer, size: number): Buffer {
  const buffer = Buffer.alloc(size, 0x41)
  head.copy(buffer)
  return buffer
}

/** Source asynchrone découpée en blocs, avec une pause entre deux blocs (entrelacement). */
export function chunked(buffer: Buffer, size = 64 * 1024): AsyncIterable<Buffer> {
  return (async function* () {
    for (let i = 0; i < buffer.length; i += size) {
      yield buffer.subarray(i, i + size)
      await new Promise((resolve) => setImmediate(resolve))
    }
  })()
}

export const fakeStatfs =
  (freeBytes: number): StatFs =>
  () => ({ bavail: freeBytes, bsize: 1 })

const fixtureRoots: string[] = []

/** Supprime les dossiers créés par filesFixture (à appeler dans afterEach). */
export function cleanupFixtures(): void {
  for (const dir of fixtureRoots.splice(0)) rmSync(dir, { recursive: true, force: true })
}

/** FileStore + UploadManager dans un dossier temporaire, disque « infini » par défaut. */
export function filesFixture(db: Database.Database, settings: Settings, freeBytes = 1e12) {
  const root = mkdtempSync(join(tmpdir(), 'inbox-files-'))
  fixtureRoots.push(root)
  const store = createFileStore({ db, root, log: () => {} })
  store.init()
  const uploads = createUploadManager({ store, settings, statfs: fakeStatfs(freeBytes), log: () => {} })
  return { root, store, uploads }
}

/** Fichiers définitifs (hors dossier .tmp). */
export const finalFiles = (root: string) => readdirSync(root).filter((name) => name !== '.tmp')
export const tempFiles = (root: string) => readdirSync(join(root, '.tmp'))
