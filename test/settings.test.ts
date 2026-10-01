import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from '../src/db/migrations.js'
import { createSettings, seedSettings, SettingValidationError } from '../src/settings/index.js'

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
