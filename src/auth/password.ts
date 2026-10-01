import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto'

const N = 16384
const R = 8
const P = 1
const KEYLEN = 64
const SALT_BYTES = 16

export const MIN_PASSWORD_LENGTH = 12
export const PASSWORD_TOO_SHORT = `Le mot de passe doit contenir au moins ${MIN_PASSWORD_LENGTH} caractères.`

function derive(pw: string, salt: Buffer, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // maxmem : 128·N·r octets nécessaires, on laisse de la marge.
    scrypt(pw, salt, KEYLEN, { ...opts, maxmem: 64 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key),
    )
  })
}

/** Hachage scrypt : "scrypt$N$r$p$selB64$hashB64". */
export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES)
  const key = await derive(pw, salt, { N, r: R, p: P })
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$')
}

/** Vérifie un mot de passe ; toute valeur stockée malformée renvoie false. */
export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  // On n'accepte que les paramètres que nous produisons (évite un DoS par valeur forgée).
  if (parts[1] !== String(N) || parts[2] !== String(R) || parts[3] !== String(P)) return false
  const salt = Buffer.from(parts[4]!, 'base64')
  const expected = Buffer.from(parts[5]!, 'base64')
  if (salt.length === 0 || expected.length !== KEYLEN) return false
  const key = await derive(pw, salt, { N, r: R, p: P })
  return timingSafeEqual(key, expected)
}
