import { timingSafeEqual } from 'node:crypto'
import type { Request } from 'express'
import type { Settings } from '../settings/index.js'

/** `x-webhook-secret` comparé en temps constant au réglage relu à chaque appel. */
export function checkWebhookSecret(req: Request, settings: Settings): boolean {
  const provided = Buffer.from(String(req.headers['x-webhook-secret'] ?? ''))
  const secret = Buffer.from(settings.get('webhook_secret'))
  return provided.length === secret.length && timingSafeEqual(provided, secret)
}
