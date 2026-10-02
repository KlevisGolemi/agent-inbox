import type Database from 'better-sqlite3'
import type { Env } from '../env.js'
import {
  DEFAULTS,
  isSecretKey,
  SETTING_KEYS,
  type SecretKey,
  type SettingKey,
  type Settings,
} from './index.js'

/**
 * Amorce les réglages au démarrage : n'écrit que les clés absentes de la table,
 * donc la graine d'environnement n'écrase jamais une valeur déjà en base.
 */
export function seedSettings(
  settings: Settings,
  db: Database.Database,
  seed: Env['seed'],
  gen: () => string,
): void {
  const present = new Set(
    (db.prepare('SELECT key FROM settings').all() as { key: string }[]).map((r) => r.key),
  )
  const fromEnv: Partial<Record<SettingKey, unknown>> = {
    webhook_secret: seed.webhookSecret,
    ttl_hours: seed.ttlHours,
    cleanup_interval_min: seed.cleanupIntervalMin,
  }
  const patch: Partial<Record<SettingKey, unknown>> = {}
  for (const key of SETTING_KEYS) {
    if (present.has(key)) continue
    patch[key] =
      fromEnv[key] ?? (isSecretKey(key) ? gen() : DEFAULTS[key as Exclude<SettingKey, SecretKey>])
  }
  if (Object.keys(patch).length > 0) settings.update(patch)
}
