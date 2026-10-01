import type Database from 'better-sqlite3'
import { z } from 'zod'
import { TOPIC_REGEX } from '../queue/validation.js'

export { seedSettings } from './seed.js'

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
} as const

export type SettingKey = keyof typeof SETTINGS
export type SettingValues = { [K in SettingKey]: z.infer<(typeof SETTINGS)[K]> }

/** Valeurs par défaut ; webhook_secret n'en a pas (généré à l'amorçage). */
export const DEFAULTS: Omit<SettingValues, 'webhook_secret'> = {
  ttl_hours: 48,
  cleanup_interval_min: 60,
  webhook_rate_limit_per_min: 100,
  update_check_enabled: true,
  lease_timeout_sec: 300,
  topic_ttl_overrides: {},
  backup_interval_hours: 24,
  backup_retention: 7,
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
    } else if (key === 'webhook_secret') {
      throw new Error('Réglage « webhook_secret » absent de la base : amorçage non exécuté')
    } else {
      value = DEFAULTS[key]
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
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
