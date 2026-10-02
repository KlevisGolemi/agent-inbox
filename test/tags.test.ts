import type Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db/index.js'
import { migrate } from '../src/db/migrations.js'
import { createQueueRepo } from '../src/queue/repo.js'
import { createSettings, seedSettings, type Settings } from '../src/settings/index.js'
import {
  AUTO_TAG_DESCRIPTION,
  createTagRegistry,
  INJECTION_MAX_CHARS,
  type TagRegistry,
} from '../src/tags/registry.js'
import { areSimilar, normalizeTagName } from '../src/tags/similarity.js'

let db: Database.Database
let settings: Settings
let tags: TagRegistry
let clock: number
const D = 'Une description suffisante'

beforeEach(() => {
  db = openDb(':memory:')
  migrate(db, () => {})
  settings = createSettings(db)
  seedSettings(settings, db, {}, () => 'x'.repeat(64))
  clock = 1_000
  tags = createTagRegistry(db, { settings, now: () => clock })
})

const make = (name: string, description = D) => {
  const r = tags.create({ name, description, createdBy: 'test', force: true })
  if (!r.ok) throw new Error(r.message)
  return r.tag
}

describe('normalisation et similarité', () => {
  it.each([
    ['Facture Client', 'facture-client'],
    ['Été  _2026', 'ete-2026'],
    ['--A--', 'a'],
    ['  Devis   ', 'devis'],
  ])('%j → %j', (raw, out) => expect(normalizeTagName(raw)).toBe(out))

  it.each([
    ['facture', 'factures', true],
    ['bug', 'bugs', true],
    ['facture', 'facture-client', true],
    ['api', 'rapide', false],
    ['client', 'cliens', true],
    ['devis', 'devise', true],
    ['urgent', 'urgence', false],
    ['photo', 'video', false],
  ])('%s ~ %s : %s', (a, b, expected) => expect(areSimilar(a, b)).toBe(expected))
})

describe('création', () => {
  it('normalise, valide la description (10–280) et retire les caractères de contrôle', () => {
    const r = tags.create({
      name: 'Facture Client',
      description: 'Factures\nreçues',
      createdBy: 'mcp:claude',
    })
    expect(r).toMatchObject({
      ok: true,
      tag: {
        name: 'facture-client',
        description: 'Factures reçues',
        usage_count: 0,
        needs_description: false,
      },
    })
    expect(tags.create({ name: '!!!', description: D, createdBy: 't' })).toMatchObject({
      ok: false,
      error: 'invalid_name',
    })
    expect(tags.create({ name: 'ok', description: 'court', createdBy: 't' })).toMatchObject({
      ok: false,
      error: 'invalid_description',
    })
    expect(tags.create({ name: 'ok', description: 'x'.repeat(281), createdBy: 't' })).toMatchObject(
      { ok: false, error: 'invalid_description' },
    )
  })

  it('refuse un doublon proche avec similar ; force crée quand même ; exact = exists', () => {
    make('facture')
    const r = tags.create({ name: 'Factures', description: D, createdBy: 't' })
    expect(r).toEqual({
      ok: false,
      error: 'similar_exists',
      message: expect.any(String),
      similar: [{ name: 'facture', description: D, usage_count: 0 }],
    })
    expect(tags.create({ name: 'factures', description: D, createdBy: 't', force: true }).ok).toBe(
      true,
    )
    expect(
      tags.create({ name: 'facture', description: D, createdBy: 't', force: true }),
    ).toMatchObject({ ok: false, error: 'exists' })
  })
})

describe('résolution MCP et HTTP', () => {
  it('MCP : tag inconnu refusé avec les tags proches et la marche à suivre', () => {
    make('facture')
    const r = tags.resolveForMcp({ tags: ['factures', 'Facture'], createdBy: 'mcp:claude' })
    expect(r).toMatchObject({
      ok: false,
      error: 'unknown_tags',
      unknown: ['factures'],
      similar: { factures: [{ name: 'facture' }] },
    })
    if (r.ok) throw new Error('attendu refus')
    expect(r.hint).toMatch(/inbox_tags/)
    expect(r.hint).toMatch(/new_tags/)
  })

  it('MCP : new_tags validé sans écriture, dédoublonné ; refus si proche', () => {
    make('facture')
    const r = tags.resolveForMcp({
      tags: ['facture'],
      newTags: [
        { name: 'Urgent', description: D },
        { name: 'urgent', description: 'Doublon dans le même appel' },
      ],
      createdBy: 'mcp:claude',
    })
    expect(r).toEqual({
      ok: true,
      tags: ['facture'],
      newTags: [{ name: 'urgent', description: D, createdBy: 'mcp:claude' }],
    })
    expect(tags.get('urgent')).toBeNull() // R11 : rien n'est écrit avant l'enqueue
    const s = tags.resolveForMcp({
      newTags: [
        { name: 'clients', description: D },
        { name: 'factures', description: D },
      ],
      createdBy: 'x',
    })
    expect(s).toMatchObject({
      ok: false,
      error: 'similar_exists',
      similar: { factures: [{ name: 'facture' }] },
    })
    expect(tags.get('clients')).toBeNull()
    // force : accepté malgré la ressemblance ; new_tag déjà existant = simple réutilisation
    expect(
      tags.resolveForMcp({
        newTags: [
          { name: 'factures', description: D },
          { name: 'facture', description: D },
        ],
        createdBy: 'x',
        force: true,
      }),
    ).toEqual({
      ok: true,
      tags: ['facture'],
      newTags: [{ name: 'factures', description: D, createdBy: 'x' }],
    })
  })

  it('MCP : un tag de `tags` créé par new_tags dans le même appel n\u2019est pas inconnu', () => {
    expect(
      tags.resolveForMcp({
        tags: ['Nouveau'],
        newTags: [{ name: 'nouveau', description: D }],
        createdBy: 'x',
      }),
    ).toEqual({
      ok: true,
      tags: [],
      newTags: [{ name: 'nouveau', description: D, createdBy: 'x' }],
    })
  })

  it('MCP : deux new_tags proches dans un même appel : refusés sans force, acceptés avec force', () => {
    const newTags = [
      { name: 'client', description: D },
      { name: 'clients', description: D },
    ]
    expect(tags.resolveForMcp({ newTags, createdBy: 'x' })).toMatchObject({
      ok: false,
      error: 'similar_exists',
      similar: { clients: [{ name: 'client', description: D, usage_count: 0 }] },
    })
    expect(tags.resolveForMcp({ newTags, createdBy: 'x', force: true })).toEqual({
      ok: true,
      tags: [],
      newTags: [
        { name: 'client', description: D, createdBy: 'x' },
        { name: 'clients', description: D, createdBy: 'x' },
      ],
    })
  })

  it('MCP : plus de 20 tags refusés', () => {
    const many = Array.from({ length: 21 }, (_, i) => `t${i}`)
    expect(tags.resolveForMcp({ tags: many, createdBy: 'x' })).toMatchObject({
      ok: false,
      error: 'too_many_tags',
    })
  })

  it('HTTP : valide sans écrire ; les inconnus reviennent en newTags needs_description', () => {
    make('existant')
    expect(
      tags.resolveForHttp(['Facture Client', 'facture-client', 'Existant'], 'http:n8n'),
    ).toEqual({
      tags: ['existant'],
      newTags: [
        {
          name: 'facture-client',
          description: AUTO_TAG_DESCRIPTION,
          createdBy: 'http:n8n',
          needsDescription: true,
        },
      ],
      invalid: [],
    })
    expect(tags.get('facture-client')).toBeNull()
    expect(tags.resolveForHttp(['ok', '!!!'], 'http:n8n')).toEqual({
      tags: [],
      newTags: [],
      invalid: ['!!!'],
    })
  })

  it('les newTags résolus sont créés par l\u2019enqueue (HTTP : needs_description ; MCP : description)', () => {
    const repo = createQueueRepo(db)
    const http = tags.resolveForHttp(['Facture Client'], 'http:n8n')
    const mcp = tags.resolveForMcp({
      newTags: [{ name: 'urgent', description: D }],
      createdBy: 'mcp:claude',
    })
    if (!mcp.ok) throw new Error('attendu ok')
    const r = repo.enqueue({
      payload: {},
      source: 't',
      correlationId: null,
      tags: http.tags,
      newTags: [...http.newTags, ...mcp.newTags],
    })
    expect(r.ok).toBe(true)
    expect(tags.get('facture-client')).toMatchObject({
      description: AUTO_TAG_DESCRIPTION,
      needs_description: true,
      created_by: 'http:n8n',
      usage_count: 1,
    })
    expect(tags.get('urgent')).toMatchObject({
      description: D,
      needs_description: false,
      usage_count: 1,
    })
  })
})

describe('pose, fusion, suppression', () => {
  function message() {
    const r = createQueueRepo(db).enqueue({ payload: {}, source: 't', correlationId: null })
    if (!r.ok) throw new Error('attendu ok')
    return r.id
  }

  it('tagMessage ajoute/retire et met à jour usage_count ; message inconnu → null', () => {
    make('a-tag')
    make('b-tag')
    const id = message()
    clock = 2_000
    expect(tags.tagMessage(id, ['a-tag', 'b-tag'], [])).toEqual(['a-tag', 'b-tag'])
    expect(tags.tagMessage(id, ['a-tag'], ['b-tag'])).toEqual(['a-tag'])
    expect(tags.get('a-tag')).toMatchObject({
      usage_count: 1,
      last_used_at: new Date(2_000).toISOString(),
    })
    expect(tags.tagMessage('00000000-0000-4000-8000-000000000000', ['a-tag'], [])).toBeNull()
  })

  it('merge A → B : liens déplacés sans doublon, usage cumulé, A supprimé', () => {
    make('alpha')
    make('beta')
    const m1 = message()
    const m2 = message()
    tags.tagMessage(m1, ['alpha', 'beta'], [])
    tags.tagMessage(m2, ['alpha'], [])
    expect(tags.merge('alpha', 'beta')).toEqual({ ok: true, moved: 1 })
    expect(tags.get('alpha')).toBeNull()
    expect(tags.get('beta')!.usage_count).toBe(3)
    expect(db.prepare('SELECT COUNT(*) AS n FROM message_tags WHERE tag = ?').get('beta')).toEqual({
      n: 2,
    })
    expect(tags.merge('beta', 'beta')).toEqual({ ok: false, error: 'same_tag' })
    expect(tags.merge('nope', 'beta')).toEqual({ ok: false, error: 'not_found' })
  })

  it('tagMessage crée les newTags dans la même transaction ; message inconnu → rien créé', () => {
    const id = message()
    const nt = [{ name: 'frais', description: D, createdBy: 'mcp:claude' }]
    expect(tags.tagMessage('00000000-0000-4000-8000-000000000000', [], [], nt)).toBeNull()
    expect(tags.get('frais')).toBeNull()
    expect(tags.tagMessage(id, [], [], nt)).toEqual(['frais'])
    expect(tags.get('frais')).toMatchObject({ usage_count: 1 })
  })

  it('updateDescription efface needs_description ; remove supprime les liens', () => {
    tags.create({
      name: 'auto',
      description: AUTO_TAG_DESCRIPTION,
      createdBy: 'http:n8n',
      needsDescription: true,
    })
    expect(tags.updateDescription('auto', 'Description enfin rédigée')).toMatchObject({
      ok: true,
      tag: { needs_description: false },
    })
    const id = message()
    tags.tagMessage(id, ['auto'], [])
    expect(tags.remove('auto')).toBe(true)
    expect(db.prepare('SELECT COUNT(*) AS n FROM message_tags').get()).toEqual({ n: 0 })
  })
})

describe('liste et injection', () => {
  it('list : par usage décroissant puis nom ; query sur nom ou description', () => {
    make('zeta', 'Zone de test numéro un')
    make('alpha', 'Premier tag de la liste')
    db.prepare("UPDATE tags SET usage_count = 5 WHERE name = 'zeta'").run()
    expect(tags.list().map((t) => t.name)).toEqual(['zeta', 'alpha'])
    expect(tags.list({ query: 'premier' }).map((t) => t.name)).toEqual(['alpha'])
  })

  it('injection : top N par usage, triés par nom, ≤ 1 500 caractères ; 0 = vide', () => {
    for (const [i, n] of ['delta', 'alpha', 'charlie', 'bravo'].entries()) {
      make(n)
      db.prepare('UPDATE tags SET usage_count = ? WHERE name = ?').run(10 - i, n)
    }
    settings.set('tags_injected_count', 3)
    const text = tags.injectionText()
    expect(text.indexOf('- alpha')).toBeLessThan(text.indexOf('- charlie'))
    expect(text.indexOf('- charlie')).toBeLessThan(text.indexOf('- delta'))
    expect(text).not.toContain('- bravo')
    for (let i = 0; i < 50; i++) make(`tag-long-${i}`, 'd'.repeat(280))
    settings.set('tags_injected_count', 50)
    expect(tags.injectionText().length).toBeLessThanOrEqual(INJECTION_MAX_CHARS)
    settings.set('tags_injected_count', 0)
    expect(tags.injectionText()).toBe('')
  })
})
