import { createHash, timingSafeEqual } from 'node:crypto'
import type { Request } from 'express'
import type { Settings } from '../settings/index.js'

const sha256 = (s: string) => createHash('sha256').update(s).digest()

/**
 * `x-webhook-secret` comparé au réglage relu à chaque appel, en temps constant quelle que soit
 * la longueur : on compare les empreintes SHA-256 (même taille), jamais les longueurs.
 */
export function checkWebhookSecret(req: Request, settings: Settings): boolean {
  const provided = sha256(String(req.headers['x-webhook-secret'] ?? ''))
  return timingSafeEqual(provided, sha256(settings.get('webhook_secret')))
}
