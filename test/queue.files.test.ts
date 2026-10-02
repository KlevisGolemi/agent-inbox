import { unlinkSync } from 'node:fs'
import { Readable } from 'node:stream'
import type Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db/index.js'
import { migrate } from '../src/db/migrations.js'
import { newAttachments } from '../src/files/attachments.js'
import type { FileStore } from '../src/files/store.js'
import type { UploadManager, UploadSession } from '../src/files/uploads.js'
import { autoTags, EXTERNAL_WARNING, itemView } from '../src/queue/http.js'
import { createQueueRepo, type EnqueueInput, type QueueRepo } from '../src/queue/repo.js'
import { createSettings, seedSettings, type Settings } from '../src/settings/index.js'
import { filesFixture, finalFiles, PDF_MINI, PNG_1X1 } from './helpers/files.js'

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
  clock = 1_000_000_000_000
  repo = createQueueRepo(db, { now: () => clock, files: store, settings })
  db.prepare(
    "INSERT INTO tags (name, description, created_by, created_at) VALUES ('facture', 'Factures reçues des clients', 't', 1)",
  ).run()
})

async function staged(buf = PDF_MINI, name = 'f.pdf'): Promise<UploadSession> {
  const s = uploads.begin()
  await s.stage(Readable.from([buf]), name)
  return s
}

function commitWith(
  s: UploadSession,
  extra: Partial<EnqueueInput> = {},
  onDownload: 'keep' | 'consume' = 'keep',
) {
  return s.commit((files) =>
    repo.enqueue({
      payload: { a: 1 },
      source: 'n8n',
      correlationId: null,
      attachments: newAttachments(files, onDownload, settings, clock),
      tags: ['facture'],
      ...extra,
    }),
  )
}

const count = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n

describe('enqueue avec pièces et tags', () => {
  it('une transaction : message, pièce, tag ; usage_count incrémenté ; vue additive', async () => {
    const r = commitWith(await staged())
    expect(r.ok).toBe(true)
    const item = repo.peek(1, 0)[0]!
    expect(item.tags).toEqual(['facture'])
    expect(item.trust).toBe('internal')
    expect(item.attachments).toEqual([
      {
        id: expect.any(String),
        filename: 'f.pdf',
        mime_type: 'application/pdf',
        category: 'document',
        size_bytes: PDF_MINI.length,
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        on_download: 'keep',
        expires_at: new Date(clock + 72 * HOUR).toISOString(),
        status: 'available',
      },
    ])
    expect(
      db.prepare("SELECT usage_count, last_used_at FROM tags WHERE name = 'facture'").get(),
    ).toEqual({
      usage_count: 1,
      last_used_at: clock,
    })
  })

  it('doublon de correlation_id : aucune ligne ni fichier résiduel', async () => {
    commitWith(await staged(), { correlationId: 'c' })
    const r = commitWith(await staged(), { correlationId: 'c' })
    expect(r).toMatchObject({ ok: false, error: 'duplicate_correlation_id' })
    expect(count('attachments')).toBe(1)
    expect(finalFiles(root)).toHaveLength(1)
  })

  it('tag inconnu (clé étrangère) : transaction annulée, fichier effacé', async () => {
    const s = await staged()
    expect(() => commitWith(s, { tags: ['inconnu'] })).toThrow(/FOREIGN KEY/)
    expect([count('messages'), count('attachments'), count('message_tags')]).toEqual([0, 0, 0])
    expect(finalFiles(root)).toEqual([])
  })

  it('R11 : new_tags créés et posés dans la transaction ; envoi refusé → aucun tag orphelin', async () => {
    const newTags = [{ name: 'recu', description: 'Reçus', createdBy: 't' }]
    const ok = repo.enqueue({ payload: {}, source: 'n8n', correlationId: 'c1', newTags })
    if (!ok.ok) throw new Error('attendu ok')
    expect(repo.findById(ok.id)!.tags).toEqual(['recu'])
    expect(db.prepare("SELECT usage_count FROM tags WHERE name = 'recu'").get()).toEqual({
      usage_count: 1,
    })
    const dup = repo.enqueue({
      payload: {},
      source: 'n8n',
      correlationId: 'c1',
      newTags: [{ name: 'autre', description: 'Autre', createdBy: 't' }],
    })
    expect(dup).toMatchObject({ ok: false, error: 'duplicate_correlation_id' })
    expect(db.prepare("SELECT COUNT(*) AS n FROM tags WHERE name = 'autre'").get()).toEqual({
      n: 0,
    })
  })

  it('une pièce vivante protège son message du TTL (deleteExpired)', async () => {
    const r = commitWith(await staged())
    if (!r.ok) throw new Error('attendu ok')
    repo.claimNext()
    expect(repo.deleteExpired(clock + 1, {}, clock + 1)).toEqual({ read: 0, pending: 0 })
    expect(repo.findById(r.id)).not.toBeNull()
  })

  it('trust et drop_id enregistrés ; findById', async () => {
    const r = commitWith(await staged(), { trust: 'external', dropId: 'd1' })
    if (!r.ok) throw new Error('attendu ok')
    expect(repo.findById(r.id)).toMatchObject({ trust: 'external', drop_id: 'd1' })
    expect(repo.findById('00000000-0000-4000-8000-000000000000')).toBeNull()
  })
})

describe('suppressions explicites : fichiers effacés', () => {
  it('deleteById', async () => {
    const r = commitWith(await staged())
    if (!r.ok) throw new Error('attendu ok')
    expect(repo.deleteById(r.id)).toBe(true)
    expect(finalFiles(root)).toEqual([])
  })

  it('clear', async () => {
    commitWith(await staged())
    commitWith(await staged(PNG_1X1, 'p.png'))
    expect(repo.clear()).toBe(2)
    expect(finalFiles(root)).toEqual([])
  })
})

describe('statut des pièces', () => {
  it('expired, consumed après délai de grâce, file_gone', async () => {
    const r = commitWith(await staged(), {}, 'consume')
    if (!r.ok) throw new Error('attendu ok')
    const id = repo.findById(r.id)!.attachments[0]!.id
    const status = () => repo.findById(r.id)!.attachments[0]!.status
    db.prepare('UPDATE attachments SET first_downloaded_at = ? WHERE id = ?').run(clock, id)
    clock += 9 * 60_000
    expect(status()).toBe('available')
    clock += 2 * 60_000
    expect(status()).toBe('consumed')
    db.prepare('UPDATE attachments SET first_downloaded_at = NULL WHERE id = ?').run(id)
    unlinkSync(store.path(id))
    expect(status()).toBe('file_gone')
    clock += 100 * HOUR
    expect(status()).toBe('expired')
  })
})

describe('recherche et tags automatiques', () => {
  it('tag (registre ou auto) et has_attachments', async () => {
    commitWith(await staged(PNG_1X1, 'p.png'), { trust: 'external', source: 'drop:Photos' })
    repo.enqueue({ payload: {}, source: 'n8n', correlationId: null, topic: 'logs' })
    expect(repo.search({ tag: 'facture' })).toHaveLength(1)
    expect(repo.search({ tag: 'type:image' })).toHaveLength(1)
    expect(repo.search({ tag: 'external' })).toHaveLength(1)
    expect(repo.search({ tag: 'source:n8n' })).toHaveLength(1)
    expect(repo.search({ tag: 'topic:logs' })).toHaveLength(1)
    expect(repo.search({ hasAttachments: true })).toHaveLength(1)
    expect(repo.search({ hasAttachments: false })).toHaveLength(1)
  })

  it('vue : auto_tags, trust external_unverified et warning', async () => {
    const r = commitWith(await staged(PNG_1X1, 'p.png'), {
      trust: 'external',
      source: 'drop:Photos',
      topic: 'drops',
    })
    if (!r.ok) throw new Error('attendu ok')
    const item = repo.findById(r.id)!
    expect(autoTags(item)).toEqual(['type:image', 'source:drop:Photos', 'topic:drops', 'external'])
    expect(itemView(item)).toMatchObject({
      trust: 'external_unverified',
      warning: EXTERNAL_WARNING,
      tags: ['facture'],
      auto_tags: ['type:image', 'source:drop:Photos', 'topic:drops', 'external'],
    })
    const internal = repo.enqueue({ payload: {}, source: 'n8n', correlationId: null })
    if (!internal.ok) throw new Error('attendu ok')
    expect(itemView(repo.findById(internal.id)!)).not.toHaveProperty('warning')
  })
})
