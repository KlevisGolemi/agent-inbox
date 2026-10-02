import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from '../src/db/migrations.js'
import {
  createSettings,
  rotateFileSigningSecret,
  seedSettings,
  SettingValidationError,
  type SettingKey,
} from '../src/settings/index.js'

const gen = () => 'x'.repeat(64)
let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  migrate(db, () => {})
})

function seeded() {
  const s = createSettings(db)
  seedSettings(s, db, {}, gen)
  return s
}

describe('réglages', () => {
  it('renvoie les défauts puis la valeur écrite, sans redémarrage', () => {
    const s = seeded()
    expect(s.get('ttl_hours')).toBe(48)
    s.set('ttl_hours', 12)
    expect(createSettings(db).get('ttl_hours')).toBe(12)
  })

  it('applique tous les défauts', () => {
    expect(seeded().all()).toEqual({
      ttl_hours: 48,
      cleanup_interval_min: 60,
      webhook_rate_limit_per_min: 100,
      webhook_secret: 'x'.repeat(64),
      update_check_enabled: true,
      lease_timeout_sec: 300,
      topic_ttl_overrides: {},
      backup_interval_hours: 24,
      backup_retention: 7,
      json_max_kb: 1024,
      attachments_enabled: true,
      attachments_max_per_message: 10,
      file_max_mb: { image: 20, audio: 50, video: 200, document: 50, archive: 500, other: 100 },
      file_allowed_categories: ['image', 'audio', 'video', 'document', 'archive', 'other'],
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
      file_signing_secret: 'x'.repeat(64),
    })
  })

  it.each([0, -1, 'abc', 9000])('refuse ttl_hours=%s et conserve la valeur', (v) => {
    const s = seeded()
    expect(() => s.set('ttl_hours', v)).toThrow(SettingValidationError)
    expect(s.get('ttl_hours')).toBe(48)
  })

  it('update est tout ou rien', () => {
    const s = seeded()
    expect(() => s.update({ ttl_hours: 10, cleanup_interval_min: 0 })).toThrow(
      SettingValidationError,
    )
    expect(s.get('ttl_hours')).toBe(48)
    expect(createSettings(db).get('ttl_hours')).toBe(48)
    s.update({ ttl_hours: 10, cleanup_interval_min: 5 })
    expect(s.get('ttl_hours')).toBe(10)
    expect(s.get('cleanup_interval_min')).toBe(5)
  })

  it("la graine d'env n'écrase jamais une valeur existante", () => {
    const s = createSettings(db)
    seedSettings(s, db, { webhookSecret: 'a'.repeat(64) }, gen)
    expect(s.get('webhook_secret')).toBe('a'.repeat(64))
    s.set('webhook_secret', 'b'.repeat(64))
    seedSettings(createSettings(db), db, { webhookSecret: 'a'.repeat(64), ttlHours: 5 }, gen)
    expect(createSettings(db).get('webhook_secret')).toBe('b'.repeat(64))
    expect(createSettings(db).get('ttl_hours')).toBe(48)
  })

  it('la graine initialise ttl et intervalle de nettoyage', () => {
    const s = createSettings(db)
    seedSettings(s, db, { ttlHours: 5, cleanupIntervalMin: 7 }, gen)
    expect(s.get('ttl_hours')).toBe(5)
    expect(s.get('cleanup_interval_min')).toBe(7)
  })

  it('notifie les abonnés (et permet de se désabonner)', () => {
    const s = seeded()
    const fn = vi.fn()
    const off = s.onChange(fn)
    s.set('ttl_hours', 2)
    expect(fn).toHaveBeenCalledWith('ttl_hours')
    off()
    s.set('ttl_hours', 3)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('valide les réglages ajoutés (§14)', () => {
    const s = seeded()
    expect(() => s.set('lease_timeout_sec', 9)).toThrow(SettingValidationError)
    expect(() => s.set('backup_interval_hours', 169)).toThrow(SettingValidationError)
    expect(() => s.set('backup_retention', 0)).toThrow(SettingValidationError)
    expect(s.set('backup_interval_hours', 0)).toBe(0)
    expect(() => s.set('webhook_secret', 'court')).toThrow(SettingValidationError)
  })

  it('topic_ttl_overrides : clés topic valides, valeurs 1–8760', () => {
    const s = seeded()
    s.set('topic_ttl_overrides', { 'mon-topic_1': 24 })
    expect(createSettings(db).get('topic_ttl_overrides')).toEqual({ 'mon-topic_1': 24 })
    expect(() => s.set('topic_ttl_overrides', { 'a b': 24 })).toThrow(SettingValidationError)
    expect(() => s.set('topic_ttl_overrides', { ok: 0 })).toThrow(SettingValidationError)
    expect(() => s.set('topic_ttl_overrides', { ok: 8761 })).toThrow(SettingValidationError)
    expect(s.get('topic_ttl_overrides')).toEqual({ 'mon-topic_1': 24 })
  })

  it('get sans graine : défaut, sauf webhook_secret qui lève une erreur claire', () => {
    const s = createSettings(db)
    expect(s.get('ttl_hours')).toBe(48)
    expect(() => s.get('webhook_secret')).toThrow(/webhook_secret/)
  })
})

const CATS = { image: 20, audio: 50, video: 200, document: 50, archive: 500, other: 100 }

describe('réglages v2.2', () => {
  it('amorce file_signing_secret et ne l’écrase jamais au redémarrage', () => {
    const s = seeded()
    s.set('file_signing_secret', 'b'.repeat(64))
    seedSettings(createSettings(db), db, {}, () => 'c'.repeat(64))
    expect(createSettings(db).get('file_signing_secret')).toBe('b'.repeat(64))
  })

  it('accepte des valeurs valides, relues sans redémarrage', () => {
    const s = seeded()
    s.update({ storage_quota_gb: 0.5, inline_max_mb: 0, file_blocked_extensions: ['exe', 'bat'] })
    const fresh = createSettings(db)
    expect(fresh.get('storage_quota_gb')).toBe(0.5)
    expect(fresh.get('inline_max_mb')).toBe(0)
    expect(fresh.get('file_blocked_extensions')).toEqual(['exe', 'bat'])
  })

  it.each([
    ['json_max_kb', 15],
    ['json_max_kb', 51201],
    ['attachments_enabled', 'oui'],
    ['attachments_max_per_message', 0],
    ['attachments_max_per_message', 51],
    ['file_max_mb', { ...CATS, image: 0 }],
    ['file_max_mb', { ...CATS, video: 2049 }],
    ['file_max_mb', { image: 20 }],
    ['file_allowed_categories', ['image', 'exe']],
    ['file_allowed_categories', ['image', 'image']],
    ['file_blocked_extensions', ['.exe']],
    ['file_blocked_extensions', Array.from({ length: 51 }, (_, i) => `e${i}`)],
    ['storage_quota_gb', 0.05],
    ['storage_quota_gb', 1001],
    ['storage_min_free_gb', -1],
    ['file_retention_hours', { ...CATS, image: 8761 }],
    ['file_retention_large_mb', 0],
    ['file_retention_large_hours', 8761],
    ['file_on_download_default', 'delete'],
    ['consume_grace_min', 0],
    ['consume_grace_min', 1441],
    ['inline_max_mb', 21],
    ['mcp_upload_max_mb', -1],
    ['download_link_ttl_min', 0],
    ['tags_injected_count', 51],
    ['drops_enabled', 1],
    ['drop_default_hours', 721],
    ['drop_max_hours', 0],
    ['drop_default_max_files', 1001],
    ['drop_rate_limit_per_min', 601],
    ['file_signing_secret', 'court'],
  ])('refuse %s = %j et conserve la valeur', (key, value) => {
    const s = seeded()
    const before = s.get(key as SettingKey)
    expect(() => s.set(key as SettingKey, value)).toThrow(SettingValidationError)
    expect(s.get(key as SettingKey)).toEqual(before)
  })

  it('rotateFileSigningSecret change le secret', () => {
    const s = seeded()
    const before = s.get('file_signing_secret')
    rotateFileSigningSecret(s)
    expect(s.get('file_signing_secret')).not.toBe(before)
    expect(s.get('file_signing_secret')).toMatch(/^[0-9a-f]{64}$/)
  })
})
