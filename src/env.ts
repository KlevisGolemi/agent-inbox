import { z } from 'zod'
import { DEFAULT_UPDATE_REPO } from './version/index.js'

export interface Env {
  publicUrl: URL
  port: number
  dbPath: string
  nodeEnv: 'production' | 'development' | 'test'
  /** Nombre de proxys de confiance devant l'application (X-Forwarded-For) : 1 par défaut. */
  trustProxy: number
  adminEmail?: string
  adminPassword?: string
  /** Dépôt GitHub des releases (vérification des mises à jour). */
  updateRepo: string
  /** Sidecar de mise à jour : présent seulement si UPDATER_URL et UPDATER_SECRET sont définis. */
  updater?: { url: URL; secret: string }
  seed: { webhookSecret?: string; ttlHours?: number; cleanupIntervalMin?: number }
}

// Une variable vide équivaut à une variable absente.
const optionalString = z.preprocess((v) => (v === '' ? undefined : v), z.string().optional())
const boundedInt = (min: number, max: number) =>
  z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce
      .number({ error: `doit être un entier entre ${min} et ${max}` })
      .int({ error: `doit être un entier entre ${min} et ${max}` })
      .min(min, { error: `doit être compris entre ${min} et ${max}` })
      .max(max, { error: `doit être compris entre ${min} et ${max}` })
      .optional(),
  )

const schema = z.object({
  PUBLIC_URL: z
    .string({ error: 'PUBLIC_URL est obligatoire' })
    .min(1, 'PUBLIC_URL est obligatoire'),
  PORT: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().positive().default(3000),
  ),
  DB_PATH: z.preprocess((v) => (v === '' ? undefined : v), z.string().default('/data/queue.db')),
  TRUST_PROXY: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce
      .number({ error: 'doit être un entier entre 0 et 5' })
      .int({ error: 'doit être un entier entre 0 et 5' })
      .min(0, { error: 'doit être compris entre 0 et 5' })
      .max(5, { error: 'doit être compris entre 0 et 5' })
      .default(1),
  ),
  NODE_ENV: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.enum(['production', 'development', 'test']).default('production'),
  ),
  UPDATE_REPO: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z
      .string()
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, { error: 'doit être de la forme « org/dépôt »' })
      .default(DEFAULT_UPDATE_REPO),
  ),
  UPDATER_URL: optionalString,
  UPDATER_SECRET: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().min(32, { error: 'doit contenir au moins 32 caractères' }).optional(),
  ),
  ADMIN_EMAIL: optionalString,
  ADMIN_PASSWORD: optionalString,
  WEBHOOK_SECRET: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z
      .string()
      .min(32, { error: 'doit contenir entre 32 et 256 caractères' })
      .max(256, { error: 'doit contenir entre 32 et 256 caractères' })
      .optional(),
  ),
  TTL_HOURS: boundedInt(1, 8760),
  CLEANUP_INTERVAL_MIN: boundedInt(1, 1440),
})

export function loadEnv(raw: Record<string, string | undefined>): Env {
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join('.') || 'env'} : ${i.message}`)
      .join(' ; ')
    throw new Error(`Configuration invalide : ${details}`)
  }
  const e = parsed.data

  let publicUrl: URL
  try {
    publicUrl = new URL(e.PUBLIC_URL)
  } catch {
    throw new Error('Configuration invalide : PUBLIC_URL n’est pas une URL valide')
  }
  if (publicUrl.protocol !== 'https:' && publicUrl.protocol !== 'http:') {
    throw new Error('Configuration invalide : PUBLIC_URL doit utiliser http ou https')
  }
  if (publicUrl.protocol === 'http:' && e.NODE_ENV !== 'development') {
    throw new Error(
      'Configuration invalide : PUBLIC_URL doit être en https (http n’est accepté qu’avec NODE_ENV=development)',
    )
  }
  publicUrl.pathname = '/'
  publicUrl.search = ''
  publicUrl.hash = ''

  let updater: Env['updater']
  if (e.UPDATER_URL !== undefined || e.UPDATER_SECRET !== undefined) {
    if (e.UPDATER_URL === undefined || e.UPDATER_SECRET === undefined) {
      throw new Error(
        'Configuration invalide : UPDATER_URL et UPDATER_SECRET doivent être définis ensemble',
      )
    }
    let url: URL
    try {
      url = new URL(e.UPDATER_URL)
    } catch {
      throw new Error('Configuration invalide : UPDATER_URL n’est pas une URL valide')
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('Configuration invalide : UPDATER_URL doit utiliser http ou https')
    }
    updater = { url, secret: e.UPDATER_SECRET }
  }

  return {
    publicUrl,
    port: e.PORT,
    dbPath: e.DB_PATH,
    nodeEnv: e.NODE_ENV,
    trustProxy: e.TRUST_PROXY,
    adminEmail: e.ADMIN_EMAIL,
    adminPassword: e.ADMIN_PASSWORD,
    updateRepo: e.UPDATE_REPO,
    updater,
    seed: {
      webhookSecret: e.WEBHOOK_SECRET,
      ttlHours: e.TTL_HOURS,
      cleanupIntervalMin: e.CLEANUP_INTERVAL_MIN,
    },
  }
}
