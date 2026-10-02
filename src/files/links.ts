import { createHmac, timingSafeEqual } from 'node:crypto'

const sign = (secret: string, id: string, exp: number | string) =>
  createHmac('sha256', secret).update(`${id}.${exp}`).digest('base64url')

/** Lien de téléchargement signé : HMAC-SHA256 de `id.exp`, `exp` en millisecondes. */
export function signFileUrl(input: {
  publicUrl: URL
  id: string
  secret: string
  ttlMin: number
  now: number
}) {
  const exp = input.now + input.ttlMin * 60_000
  const url = new URL(`files/${input.id}`, input.publicUrl)
  url.searchParams.set('exp', String(exp))
  url.searchParams.set('sig', sign(input.secret, input.id, exp))
  return { url: url.href, exp, expires_at: new Date(exp).toISOString() }
}

/** Comparaison en temps constant ; toute anomalie (format, échéance, longueur) → false. */
export function verifyFileSignature(
  id: string,
  exp: string,
  sig: string,
  secret: string,
  now: number,
): boolean {
  if (!/^\d{1,16}$/.test(exp) || Number(exp) <= now) return false
  const expected = Buffer.from(sign(secret, id, exp))
  const given = Buffer.from(sig)
  return given.length === expected.length && timingSafeEqual(given, expected)
}
