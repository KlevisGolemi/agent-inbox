import { randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import { z } from 'zod'
import { FILE_CATEGORIES } from '../files/types.js'
import { EXTENSION_REGEX, TOPIC_REGEX } from '../queue/validation.js'

export { seedSettings } from './seed.js'

/** Une valeur par catégorie de fichier, toutes obligatoires. */
const perCategory = (min: number, max: number) => {
  const n = z.number().int().min(min).max(max)
  return z.object({ image: n, audio: n, video: n, document: n, archive: n, other: n }).strict()
}

export const SETTINGS = {
  ttl_hours: z.number().int().min(1).max(8760),
  cleanup_interval_min: z.number().int().min(1).max(1440),
  webhook_rate_limit_per_min: z.number().int().min(1).max(10000),
  webhook_secret: z.string().min(32).max(256),
  update_check_enabled: z.boolean(),
  lease_timeout_sec: z.number().int().min(10).max(86400),
  topic_ttl_overrides: z.record(z.string().regex(TOPIC_REGEX), z.number().int().min(1).max(8760)),
  backup_interval_hours: z.number().int().min(0).max(168),
  backup_retention: z.number().int().min(1).max(90),
  json_max_kb: z.number().int().min(16).max(51200),
  attachments_enabled: z.boolean(),
  attachments_max_per_message: z.number().int().min(1).max(50),
  file_max_mb: perCategory(1, 2048),
  file_allowed_categories: z
    .array(z.enum(FILE_CATEGORIES))
    .max(FILE_CATEGORIES.length)
    .refine((a) => new Set(a).size === a.length, 'Catégories en double'),
  file_blocked_extensions: z.array(z.string().regex(EXTENSION_REGEX)).max(50),
  storage_quota_gb: z.number().min(0.1).max(1000),
  storage_min_free_gb: z.number().min(0).max(1000),
  file_retention_hours: perCategory(1, 8760),
  file_retention_large_mb: z.number().int().min(1).max(2048),
  file_retention_large_hours: z.number().int().min(1).max(8760),
  file_on_download_default: z.enum(['keep', 'consume']),
  consume_grace_min: z.number().int().min(1).max(1440),
  inline_max_mb: z.number().min(0).max(20),
  mcp_upload_max_mb: z.number().min(0).max(20),
  download_link_ttl_min: z.number().int().min(1).max(1440),
  tags_injected_count: z.number().int().min(0).max(50),
  drops_enabled: z.boolean(),
  drop_default_hours: z.number().int().min(1).max(720),
  drop_max_hours: z.number().int().min(1).max(720),
  drop_default_max_files: z.number().int().min(1).max(1000),
  drop_rate_limit_per_min: z.number().int().min(1).max(600),
  file_signing_secret: z.string().min(32).max(256),
} as const

export type SettingKey = keyof typeof SETTINGS
export type SettingValues = { [K in SettingKey]: z.infer<(typeof SETTINGS)[K]> }

/** Secrets générés à l'amorçage (jamais de valeur par défaut). */
export const SECRET_KEYS = ['webhook_secret', 'file_signing_secret'] as const
export type SecretKey = (typeof SECRET_KEYS)[number]
export const isSecretKey = (key: SettingKey): key is SecretKey =>
  (SECRET_KEYS as readonly string[]).includes(key)

/** Valeurs par défaut ; les secrets n'en ont pas (générés à l'amorçage). */
export const DEFAULTS: Omit<SettingValues, SecretKey> = {
  ttl_hours: 48,
  cleanup_interval_min: 60,
  webhook_rate_limit_per_min: 100,
  update_check_enabled: true,
  lease_timeout_sec: 300,
  topic_ttl_overrides: {},
  backup_interval_hours: 24,
  backup_retention: 7,
  json_max_kb: 1024,
  attachments_enabled: true,
  attachments_max_per_message: 10,
  // video et archive à 95 Mo : sous la limite de corps de Cloudflare Free/Pro (100 Mo) ; réglables en base.
  file_max_mb: { image: 20, audio: 50, video: 95, document: 50, archive: 95, other: 100 },
  file_allowed_categories: [...FILE_CATEGORIES],
  file_blocked_extensions: [],
  storage_quota_gb: 5,
  storage_min_free_gb: 2,
  file_retention_hours: { image: 168, audio: 72, video: 24, document: 72, archive: 24, other: 72 },
  file_retention_large_mb: 50,
  file_retention_large_hours: 24,
  file_on_download_default: 'keep',
  consume_grace_min: 10,
  inline_max_mb: 5,
  mcp_upload_max_mb: 5,
  download_link_ttl_min: 60,
  tags_injected_count: 15,
  drops_enabled: true,
  drop_default_hours: 24,
  drop_max_hours: 168,
  drop_default_max_files: 10,
  drop_rate_limit_per_min: 10,
}

/** Secret aléatoire de 256 bits (hexadécimal). */
export const generateSecret = (): string => randomBytes(32).toString('hex')

/** Après une restauration : les liens signés émis auparavant deviennent invalides. */
export function rotateFileSigningSecret(settings: Settings): void {
  settings.set('file_signing_secret', generateSecret())
}

export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[]

export class SettingValidationError extends Error {
  constructor(
    public key: SettingKey,
    message: string,
  ) {
    super(message)
    this.name = 'SettingValidationError'
  }
}

export interface Settings {
  get<K extends SettingKey>(key: K): SettingValues[K]
  /** webhook_secret inclus (l'API d'administration le masque). */
  all(): SettingValues
  /** Lève SettingValidationError ; la valeur précédente est conservée. */
  set<K extends SettingKey>(key: K, value: unknown): SettingValues[K]
  /** Tout ou rien : si une valeur est invalide, rien n'est écrit. */
  update(patch: Partial<Record<SettingKey, unknown>>): SettingValues
  onChange(listener: (key: SettingKey) => void): () => void
  /** Vide le cache et prévient les écouteurs (après un remplacement du contenu de la base). */
  reload(): void
}

function parse<K extends SettingKey>(key: K, value: unknown): SettingValues[K] {
  const result = SETTINGS[key].safeParse(value)
  if (!result.success) {
    const detail = result.error.issues.map((i) => i.message).join(' ; ')
    throw new SettingValidationError(key, `Réglage « ${key} » invalide : ${detail}`)
  }
  return result.data as SettingValues[K]
}

export function createSettings(db: Database.Database): Settings {
  const cache = new Map<SettingKey, unknown>()
  const listeners = new Set<(key: SettingKey) => void>()
  const selectOne = db.prepare('SELECT value FROM settings WHERE key = ?')
  const upsert = db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )

  function get<K extends SettingKey>(key: K): SettingValues[K] {
    if (cache.has(key)) return cache.get(key) as SettingValues[K]
    const row = selectOne.get(key) as { value: string } | undefined
    let value: unknown
    if (row) {
      value = parse(key, JSON.parse(row.value))
    } else if (isSecretKey(key)) {
      throw new Error(`Réglage « ${key} » absent de la base : amorçage non exécuté`)
    } else {
      value = DEFAULTS[key as Exclude<SettingKey, SecretKey>]
    }
    cache.set(key, value)
    return value as SettingValues[K]
  }

  function update(patch: Partial<Record<SettingKey, unknown>>): SettingValues {
    const entries: [SettingKey, unknown][] = []
    for (const key of SETTING_KEYS) {
      if (key in patch) entries.push([key, parse(key, patch[key])])
    }
    const now = Date.now()
    db.transaction(() => {
      for (const [key, value] of entries) upsert.run(key, JSON.stringify(value), now)
    })()
    for (const [key, value] of entries) cache.set(key, value)
    for (const [key] of entries) for (const l of listeners) l(key)
    return all()
  }

  function all(): SettingValues {
    return Object.fromEntries(SETTING_KEYS.map((k) => [k, get(k)])) as SettingValues
  }

  return {
    get,
    all,
    set<K extends SettingKey>(key: K, value: unknown): SettingValues[K] {
      update({ [key]: value })
      return get(key)
    },
    update,
    reload() {
      cache.clear()
      for (const key of SETTING_KEYS) for (const l of listeners) l(key)
    },
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
