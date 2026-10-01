import { randomBytes } from 'node:crypto'
import type { Env } from '../env.js'
import type { LogLevel } from '../log.js'
import { MIN_PASSWORD_LENGTH } from './password.js'
import { isValidEmail, type Users } from './users.js'

type LogFn = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void

// 32 symboles sans ambiguïté (ni I, O, 0, 1) : un octet & 31 donne un tirage uniforme.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/** Code de setup à usage unique : 6 groupes de 4 caractères (120 bits). */
export function createSetupCode(): string {
  const bytes = randomBytes(24)
  const chars = Array.from(bytes, (b) => ALPHABET[b & 31]!)
  const groups: string[] = []
  for (let i = 0; i < 24; i += 4) groups.push(chars.slice(i, i + 4).join(''))
  return groups.join('-')
}

/** Normalise une saisie de code : majuscules, sans espaces ni tirets. */
export function normalizeSetupCode(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/**
 * Au démarrage : crée le compte depuis ADMIN_EMAIL + ADMIN_PASSWORD si aucun utilisateur
 * n'existe ; sinon, s'il n'y a toujours aucun compte, génère un code de setup et le journalise
 * (seule exception à la règle « aucun secret dans les logs »).
 */
export async function ensureAdmin({
  users,
  env,
  log,
}: {
  users: Users
  env: Env
  log: LogFn
}): Promise<{ setupCode: string | null }> {
  if (users.count() > 0) return { setupCode: null }
  if (env.adminEmail && env.adminPassword) {
    if (!isValidEmail(env.adminEmail)) {
      throw new Error('Configuration invalide : ADMIN_EMAIL n’est pas une adresse email valide')
    }
    if (env.adminPassword.length < MIN_PASSWORD_LENGTH) {
      throw new Error(
        `Configuration invalide : ADMIN_PASSWORD doit contenir au moins ${MIN_PASSWORD_LENGTH} caractères`,
      )
    }
    await users.create(env.adminEmail, env.adminPassword)
    log('info', 'Compte administrateur créé depuis l’environnement')
    return { setupCode: null }
  }
  const setupCode = createSetupCode()
  log('warn', 'Aucun compte administrateur : ouvrez l’URL de configuration et saisissez ce code', {
    url: `${env.publicUrl.href}setup`,
    setup_code: setupCode,
  })
  return { setupCode }
}
