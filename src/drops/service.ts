import type { FileCategory, OnDownload } from '../files/types.js'
import { CORRELATION_ID_REGEX, TOPIC_REGEX } from '../queue/validation.js'
import type { Settings } from '../settings/index.js'
import type { NewTag } from '../tags/attach.js'
import type { NewTagInput, SimilarTag, TagRegistry } from '../tags/registry.js'
import type { DropsRepo, DropView } from './repo.js'

export const SELF_LINK_TTL_MIN = 15
export const DROP_LABEL_MAX = 80
export const DEFAULT_DROP_TOPIC = 'drops'
const HOUR_MS = 3_600_000

export interface DropServiceDeps {
  drops: DropsRepo
  tags: TagRegistry
  settings: Settings
  publicUrl: URL
  now?: () => number
}
export type DropServiceError = {
  ok: false
  error: string
  message: string
  hint?: string
  field?: string
  max?: number
  unknown?: string[]
  similar?: Record<string, SimilarTag[]>
}
export type DropCreated = {
  ok: true
  drop: DropView
  url: string
  curl: string
  expires_at: string
}
export interface PublicDropInput {
  label: string
  topic?: string
  tags?: string[]
  expiresInHours?: number
  maxFiles?: number
  maxFileMb?: number
  allowedCategories?: FileCategory[]
  createdBy: string
}
export interface SelfLinkInput {
  topic?: string
  tags?: string[]
  newTags?: NewTagInput[]
  correlationId?: string
  payload?: Record<string, unknown>
  onDownload?: OnDownload
  createdBy: string
}

export const dropUrl = (publicUrl: URL, token: string): string =>
  new URL(`d/${token}`, publicUrl).href
const err = (
  error: string,
  message: string,
  extra: Partial<DropServiceError> = {},
): DropServiceError => ({ ok: false, error, message, ...extra })
const maxMbFor = (settings: Settings, cats: readonly FileCategory[]) =>
  Math.max(...cats.map((c) => settings.get('file_max_mb')[c]))

/** Libellé affiché au déposant : caractères de contrôle remplacés par des espaces (sans regex, R7). */
function cleanLabel(raw: string): string {
  return Array.from(raw, (c) => {
    const code = c.charCodeAt(0)
    return code < 32 || code === 127 ? ' ' : c
  })
    .join('')
    .trim()
}

/** Validation seule (R11) : les tags à créer sont posés dans la transaction de création du lien. */
function resolveTags(
  deps: DropServiceDeps,
  tags: string[] | undefined,
  newTags: NewTagInput[] | undefined,
  createdBy: string,
): { ok: true; names: string[]; fresh: NewTag[] } | DropServiceError {
  if (!tags?.length && !newTags?.length) return { ok: true, names: [], fresh: [] }
  const r = deps.tags.resolveForMcp({
    ...(tags ? { tags } : {}),
    ...(newTags ? { newTags } : {}),
    createdBy,
  })
  if (r.ok) return { ok: true, names: r.tags, fresh: r.newTags }
  return err(r.error, r.message, {
    hint: r.hint,
    ...(r.unknown ? { unknown: r.unknown } : {}),
    ...(r.similar ? { similar: r.similar } : {}),
  })
}

export function createPublicDrop(
  deps: DropServiceDeps,
  input: PublicDropInput,
): DropCreated | DropServiceError {
  const { settings } = deps
  const now = (deps.now ?? Date.now)()
  if (!settings.get('drops_enabled'))
    return err('drops_disabled', 'Les liens de dépôt sont désactivés sur ce serveur.')
  const label = cleanLabel(input.label)
  if (label.length === 0 || label.length > DROP_LABEL_MAX)
    return err('invalid_label', `Libellé obligatoire, ${DROP_LABEL_MAX} caractères au plus.`)
  const topic = input.topic ?? DEFAULT_DROP_TOPIC
  if (!TOPIC_REGEX.test(topic))
    return err('invalid_topic', 'Topic invalide : ^[A-Za-z0-9_-]{1,128}$')
  const maxHours = settings.get('drop_max_hours')
  const hours = input.expiresInHours ?? Math.min(settings.get('drop_default_hours'), maxHours)
  if (hours > maxHours)
    return err('out_of_bounds', `Durée maximale : ${maxHours} h.`, {
      field: 'expires_in_hours',
      max: maxHours,
    })
  const allowedBySettings = settings.get('file_allowed_categories')
  const allowed = input.allowedCategories ?? allowedBySettings
  if (allowed.length === 0 || allowed.some((c) => !allowedBySettings.includes(c)))
    return err(
      'out_of_bounds',
      `Catégories acceptées par le serveur : ${allowedBySettings.join(', ')}.`,
      { field: 'allowed_categories' },
    )
  const maxMb = maxMbFor(settings, allowed)
  const fileMb = input.maxFileMb ?? maxMb
  if (fileMb > maxMb)
    return err('out_of_bounds', `Taille maximale par fichier : ${maxMb} Mo.`, {
      field: 'max_file_mb',
      max: maxMb,
    })
  const tags = resolveTags(deps, input.tags, undefined, input.createdBy)
  if (!tags.ok) return tags
  const { drop, token } = deps.drops.create({
    kind: 'public',
    label,
    topic,
    tags: tags.names,
    maxFiles: input.maxFiles ?? settings.get('drop_default_max_files'),
    maxFileMb: fileMb,
    allowedCategories: [...allowed],
    expiresAt: now + hours * HOUR_MS,
    createdBy: input.createdBy,
  })
  const url = dropUrl(deps.publicUrl, token)
  return {
    ok: true,
    drop,
    url,
    curl: `curl -F file=@<chemin-du-fichier> -F text='message optionnel' '${url}'`,
    expires_at: drop.expires_at,
  }
}

export function createSelfLink(
  deps: DropServiceDeps,
  input: SelfLinkInput,
): DropCreated | DropServiceError {
  const { settings } = deps
  const now = (deps.now ?? Date.now)()
  if (!settings.get('attachments_enabled'))
    return err('attachments_disabled', 'Les pièces jointes sont désactivées sur ce serveur.')
  const topic = input.topic ?? 'default'
  if (!TOPIC_REGEX.test(topic))
    return err('invalid_topic', 'Topic invalide : ^[A-Za-z0-9_-]{1,128}$')
  if (input.correlationId !== undefined && !CORRELATION_ID_REGEX.test(input.correlationId))
    return err('invalid_correlation_id', 'Format attendu : ^[A-Za-z0-9_-]{1,128}$')
  const tags = resolveTags(deps, input.tags, input.newTags, input.createdBy)
  if (!tags.ok) return tags
  const allowed = settings.get('file_allowed_categories')
  if (allowed.length === 0)
    return err('attachments_disabled', 'Aucune catégorie de fichier n’est acceptée.')
  const { drop, token } = deps.drops.create({
    kind: 'self',
    label: 'upload',
    topic,
    tags: tags.names,
    newTags: tags.fresh,
    maxFiles: settings.get('attachments_max_per_message'),
    maxFileMb: maxMbFor(settings, allowed),
    allowedCategories: [...allowed],
    expiresAt: now + SELF_LINK_TTL_MIN * 60_000,
    createdBy: input.createdBy,
    messagePayload: input.payload ?? null,
    correlationId: input.correlationId ?? null,
    onDownload: input.onDownload ?? null,
  })
  const url = dropUrl(deps.publicUrl, token)
  return {
    ok: true,
    drop,
    url,
    curl: `curl -F file=@<chemin-du-fichier> '${url}'`,
    expires_at: drop.expires_at,
  }
}
