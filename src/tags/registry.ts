import type Database from 'better-sqlite3'
import { TAG_NAME_REGEX } from '../queue/validation.js'
import type { Settings } from '../settings/index.js'
import { attachTags, createTags, type NewTag } from './attach.js'
import { areSimilar, normalizeTagName } from './similarity.js'

export const TAG_DESCRIPTION_MIN = 10
export const TAG_DESCRIPTION_MAX = 280
export const MAX_TAGS_PER_MESSAGE = 20
export const INJECTION_MAX_CHARS = 1500
const INJECTED_DESCRIPTION_CHARS = 80
export const AUTO_TAG_DESCRIPTION = 'Créé automatiquement par l’API HTTP : description à compléter.'
export const UNKNOWN_TAG_HINT =
  'Routine : vérifie le registre avec inbox_tags, réutilise un tag existant (voir « similar »), ' +
  'sinon crée-le avec new_tags ou inbox_create_tag (description obligatoire, 10 à 280 caractères).'

export interface Tag {
  name: string
  description: string
  created_by: string
  created_at: string
  usage_count: number
  last_used_at: string | null
  needs_description: boolean
}
export interface SimilarTag {
  name: string
  description: string
  usage_count: number
}
export interface NewTagInput {
  name: string
  description: string
}
export type CreateTagResult =
  | { ok: true; tag: Tag }
  | {
      ok: false
      error: 'invalid_name' | 'invalid_description' | 'exists' | 'similar_exists'
      message: string
      similar?: SimilarTag[]
    }
/**
 * Résolution SANS écriture (R11) : `tags` = noms déjà au registre, `newTags` = à créer dans la transaction
 * d'enqueue (ou de pose), dédoublonnés par nom normalisé.
 */
export type ResolveResult =
  | { ok: true; tags: string[]; newTags: NewTag[] }
  | {
      ok: false
      error:
        'unknown_tags' | 'invalid_name' | 'invalid_description' | 'similar_exists' | 'too_many_tags'
      message: string
      hint: string
      unknown?: string[]
      similar?: Record<string, SimilarTag[]>
    }
export interface TagRegistry {
  list(opts?: { query?: string; limit?: number }): Tag[]
  get(name: string): Tag | null
  similarTo(name: string): SimilarTag[]
  create(
    input: NewTagInput & { createdBy: string; force?: boolean; needsDescription?: boolean },
  ): CreateTagResult
  resolveForMcp(input: {
    tags?: string[]
    newTags?: NewTagInput[]
    createdBy: string
    force?: boolean
  }): ResolveResult
  /** Validation seule : les tags absents reviennent dans `newTags` (needs_description) pour l'enqueue. */
  resolveForHttp(
    rawNames: string[],
    createdBy: string,
  ): { tags: string[]; newTags: NewTag[]; invalid: string[] }
  /** Pose/retrait ; `newTags` (déjà validés par resolveForMcp) sont créés dans la même transaction. */
  tagMessage(
    messageId: string,
    add: readonly string[],
    remove: readonly string[],
    newTags?: readonly NewTag[],
  ): string[] | null
  updateDescription(name: string, description: string): CreateTagResult
  merge(
    from: string,
    into: string,
  ): { ok: true; moved: number } | { ok: false; error: 'not_found' | 'same_tag' }
  remove(name: string): boolean
  injectionText(): string
}

type TagRow = {
  name: string
  description: string
  created_by: string
  created_at: number
  usage_count: number
  last_used_at: number | null
  needs_description: number
}

const toTag = (r: TagRow): Tag => ({
  name: r.name,
  description: r.description,
  created_by: r.created_by,
  created_at: new Date(r.created_at).toISOString(),
  usage_count: r.usage_count,
  last_used_at: r.last_used_at === null ? null : new Date(r.last_used_at).toISOString(),
  needs_description: r.needs_description === 1,
})
/** Caractères de contrôle → espace (par code, sans regex de contrôle), espaces réduits. */
const cleanDescription = (d: string) =>
  Array.from(d, (c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`)
const descriptionError = () => ({
  ok: false as const,
  error: 'invalid_description' as const,
  message: `Description obligatoire : ${TAG_DESCRIPTION_MIN} à ${TAG_DESCRIPTION_MAX} caractères.`,
})

export function createTagRegistry(
  db: Database.Database,
  opts: { settings: Settings; now?: () => number },
): TagRegistry {
  const now = opts.now ?? Date.now
  const selectOne = db.prepare('SELECT * FROM tags WHERE name = ?')
  const selectAll = db.prepare('SELECT * FROM tags')

  const get = (name: string) => {
    const r = selectOne.get(name) as TagRow | undefined
    return r ? toTag(r) : null
  }
  const similarTo = (name: string): SimilarTag[] =>
    (selectAll.all() as TagRow[])
      .filter((r) => r.name !== name && areSimilar(name, r.name))
      .sort((x, y) => y.usage_count - x.usage_count || (x.name < y.name ? -1 : 1))
      .slice(0, 5)
      .map((r) => ({ name: r.name, description: r.description, usage_count: r.usage_count }))

  type Checked =
    { ok: true; name: string; description: string } | Extract<CreateTagResult, { ok: false }>
  function check(input: NewTagInput, force: boolean): Checked {
    const name = normalizeTagName(input.name)
    if (!TAG_NAME_REGEX.test(name))
      return {
        ok: false,
        error: 'invalid_name',
        message: 'Nom invalide : lettres minuscules, chiffres et tirets, 48 caractères au plus.',
      }
    const description = cleanDescription(input.description)
    if (description.length < TAG_DESCRIPTION_MIN || description.length > TAG_DESCRIPTION_MAX)
      return descriptionError()
    if (get(name))
      return {
        ok: false,
        error: 'exists',
        message: `Le tag « ${name} » existe déjà : réutilise-le.`,
      }
    const similar = force ? [] : similarTo(name)
    if (similar.length > 0)
      return {
        ok: false,
        error: 'similar_exists',
        message: 'Un tag proche existe déjà : réutilise-le ou passe force: true.',
        similar,
      }
    return { ok: true, name, description }
  }

  function create(
    input: NewTagInput & { createdBy: string; force?: boolean; needsDescription?: boolean },
  ): CreateTagResult {
    const c = check(input, input.force === true)
    if (!c.ok) return c
    createTags(
      db,
      [
        {
          name: c.name,
          description: c.description,
          createdBy: input.createdBy,
          needsDescription: input.needsDescription,
        },
      ],
      now(),
    )
    return { ok: true, tag: get(c.name)! }
  }

  function resolveForMcp(input: {
    tags?: string[]
    newTags?: NewTagInput[]
    createdBy: string
    force?: boolean
  }): ResolveResult {
    const wanted = [...new Set((input.tags ?? []).map(normalizeTagName))]
    // Deux new_tags de même nom normalisé : le premier l'emporte.
    const fresh = new Map<string, NewTagInput>()
    for (const t of input.newTags ?? []) {
      const n = normalizeTagName(t.name)
      if (!fresh.has(n)) fresh.set(n, t)
    }
    if (new Set([...wanted, ...fresh.keys()]).size > MAX_TAGS_PER_MESSAGE)
      return {
        ok: false,
        error: 'too_many_tags',
        message: `${MAX_TAGS_PER_MESSAGE} tags au maximum.`,
        hint: UNKNOWN_TAG_HINT,
      }

    // Tout est validé avant de rien renvoyer à créer ; aucune écriture ici.
    const toCreate: NewTag[] = []
    const reused: string[] = []
    const similar: Record<string, SimilarTag[]> = {}
    for (const [n, t] of fresh) {
      const c = check(t, input.force === true)
      if (c.ok) {
        // Même anti-doublon entre new_tags d'un même appel (sauf force).
        const twins = input.force === true ? [] : toCreate.filter((t) => areSimilar(c.name, t.name))
        if (twins.length > 0)
          similar[n] = twins.map((t) => ({
            name: t.name,
            description: t.description,
            usage_count: 0,
          }))
        else toCreate.push({ name: c.name, description: c.description, createdBy: input.createdBy })
      } else if (c.error === 'exists')
        reused.push(n) // déjà là : simple réutilisation
      else if (c.error === 'similar_exists') similar[n] = c.similar ?? []
      else return { ok: false, error: c.error, message: c.message, hint: UNKNOWN_TAG_HINT }
    }
    if (Object.keys(similar).length > 0)
      return {
        ok: false,
        error: 'similar_exists',
        message: 'Des tags proches existent déjà : réutilise-les ou passe force: true.',
        similar,
        hint: UNKNOWN_TAG_HINT,
      }
    const creating = new Set(toCreate.map((t) => t.name))
    const unknown = wanted.filter((n) => !creating.has(n) && !get(n))
    if (unknown.length > 0) {
      const invalid = unknown.filter((n) => !TAG_NAME_REGEX.test(n))
      if (invalid.length > 0)
        return {
          ok: false,
          error: 'invalid_name',
          message: `Nom de tag invalide : ${invalid.join(', ')}.`,
          hint: UNKNOWN_TAG_HINT,
        }
      return {
        ok: false,
        error: 'unknown_tags',
        message: `Tag inconnu : ${unknown.join(', ')}.`,
        unknown,
        similar: Object.fromEntries(unknown.map((n) => [n, similarTo(n)])),
        hint: UNKNOWN_TAG_HINT,
      }
    }
    const existing = [...new Set([...wanted.filter((n) => !creating.has(n)), ...reused])]
    return { ok: true, tags: existing, newTags: toCreate }
  }

  function resolveForHttp(rawNames: string[], createdBy: string) {
    const invalid = rawNames.filter((r) => !TAG_NAME_REGEX.test(normalizeTagName(r)))
    if (invalid.length > 0) return { tags: [], newTags: [], invalid }
    const names = [...new Set(rawNames.map(normalizeTagName))]
    const tags = names.filter((n) => get(n))
    const newTags: NewTag[] = names
      .filter((n) => !get(n))
      .map((name) => ({
        name,
        description: AUTO_TAG_DESCRIPTION,
        createdBy,
        needsDescription: true,
      }))
    return { tags, newTags, invalid: [] }
  }

  function tagMessage(
    messageId: string,
    add: readonly string[],
    remove: readonly string[],
    newTags: readonly NewTag[] = [],
  ): string[] | null {
    return db.transaction(() => {
      if (!db.prepare('SELECT 1 FROM messages WHERE id = ?').get(messageId)) return null
      createTags(db, newTags, now())
      attachTags(
        db,
        messageId,
        [...add.map(normalizeTagName), ...newTags.map((t) => t.name)],
        now(),
      )
      const del = db.prepare('DELETE FROM message_tags WHERE message_id = ? AND tag = ?')
      for (const r of remove) del.run(messageId, normalizeTagName(r))
      return (
        db
          .prepare('SELECT tag FROM message_tags WHERE message_id = ? ORDER BY tag')
          .all(messageId) as {
          tag: string
        }[]
      ).map((t) => t.tag)
    })()
  }

  return {
    list({ query, limit = 50 } = {}) {
      const rows = query
        ? db
            .prepare(
              `SELECT * FROM tags WHERE name LIKE :q ESCAPE '\\' OR description LIKE :q ESCAPE '\\'
                ORDER BY usage_count DESC, name ASC LIMIT :limit`,
            )
            .all({ q: `%${escapeLike(query)}%`, limit })
        : db.prepare('SELECT * FROM tags ORDER BY usage_count DESC, name ASC LIMIT ?').all(limit)
      return (rows as TagRow[]).map(toTag)
    },
    get,
    similarTo,
    create,
    resolveForMcp,
    resolveForHttp,
    tagMessage,
    updateDescription(name, description) {
      const d = cleanDescription(description)
      if (d.length < TAG_DESCRIPTION_MIN || d.length > TAG_DESCRIPTION_MAX)
        return descriptionError()
      if (
        db
          .prepare('UPDATE tags SET description = ?, needs_description = 0 WHERE name = ?')
          .run(d, name).changes === 0
      )
        return { ok: false, error: 'invalid_name', message: 'Tag introuvable.' }
      return { ok: true, tag: get(name)! }
    },
    merge(from, into) {
      if (from === into) return { ok: false, error: 'same_tag' }
      if (!get(from) || !get(into)) return { ok: false, error: 'not_found' }
      return db.transaction(() => {
        const moved = db
          .prepare(
            'INSERT OR IGNORE INTO message_tags (message_id, tag) SELECT message_id, ? FROM message_tags WHERE tag = ?',
          )
          .run(into, from).changes
        db.prepare(
          'INSERT OR IGNORE INTO drop_tags (drop_id, tag) SELECT drop_id, ? FROM drop_tags WHERE tag = ?',
        ).run(into, from)
        db.prepare(
          `UPDATE tags SET usage_count = usage_count + (SELECT usage_count FROM tags WHERE name = :from),
                  last_used_at = NULLIF(MAX(COALESCE(last_used_at, 0), COALESCE((SELECT last_used_at FROM tags WHERE name = :from), 0)), 0)
            WHERE name = :into`,
        ).run({ from, into })
        db.prepare('DELETE FROM tags WHERE name = ?').run(from)
        return { ok: true as const, moved }
      })()
    },
    remove: (name) => db.prepare('DELETE FROM tags WHERE name = ?').run(name).changes > 0,
    injectionText() {
      const n = opts.settings.get('tags_injected_count')
      if (n === 0) return ''
      const top = (
        db
          .prepare('SELECT name, description FROM tags ORDER BY usage_count DESC, name ASC LIMIT ?')
          .all(n) as {
          name: string
          description: string
        }[]
      ).sort((a, b) => (a.name < b.name ? -1 : 1))
      if (top.length === 0) return ''
      let text = '\n\nTags existants (réutilise-les ; liste complète : inbox_tags) :'
      for (const t of top) {
        const d =
          t.description.length > INJECTED_DESCRIPTION_CHARS
            ? t.description.slice(0, INJECTED_DESCRIPTION_CHARS - 1) + '…'
            : t.description
        const line = `\n- ${t.name} : ${d}`
        if (text.length + line.length > INJECTION_MAX_CHARS) break
        text += line
      }
      return text
    },
  }
}
