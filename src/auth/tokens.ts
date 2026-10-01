import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** Jeton aléatoire en base64url (32 octets par défaut → 43 caractères). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

/** Empreinte SHA-256 en hexadécimal (seule forme stockée en base pour jetons, codes et sessions). */
export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

/** Comparaison à temps constant de deux chaînes de longueur quelconque. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest()
  const hb = createHash('sha256').update(b).digest()
  return timingSafeEqual(ha, hb) && a.length === b.length
}
