import express, { type RequestHandler } from 'express'
import { closeAfterResponse, lingerAfterError } from '../files/http.js'
import { checkWebhookSecret } from '../queue/secret.js'
import type { Settings } from '../settings/index.js'

export const DEFAULT_JSON_LIMIT_BYTES = 1024 * 1024
export const MCP_JSON_MARGIN_BYTES = 64 * 1024
/** Surcoût du base64 (4/3) plus marge JSON. */
export const BASE64_OVERHEAD = 1.37
const MB = 1024 * 1024

/** Limite du corps JSON pour un chemin, relue à chaque requête (réglages à chaud). */
export function jsonLimitFor(path: string, settings: Settings): number {
  const base = settings.get('json_max_kb') * 1024
  if (path === '/webhook') return base
  if (path === '/mcp') {
    return (
      base +
      Math.ceil(settings.get('mcp_upload_max_mb') * BASE64_OVERHEAD) * MB +
      MCP_JSON_MARGIN_BYTES
    )
  }
  return DEFAULT_JSON_LIMIT_BYTES
}

/**
 * Parseur JSON choisi par requête : une instance `express.json` par valeur de limite (mémoïsée),
 * ce qui conserve les erreurs `entity.too.large` / `entity.parse.failed` (413 / 400) existantes.
 */
export function createJsonBody(settings: Settings): RequestHandler {
  const parsers = new Map<number, RequestHandler>()
  return (req, res, next) => {
    const limit = jsonLimitFor(req.path, settings)
    // Corps JSON annoncé trop gros : refus immédiat (express.json le lirait en entier avant de
    // répondre). Producteur authentifié (secret webhook valide) : lingering borné pour qu'il lise
    // bien le 413 ; sinon fermeture immédiate, rien n'est lu pour un inconnu.
    if (req.is('application/json') && Number(req.headers['content-length']) > limit) {
      if (req.path === '/webhook' && checkWebhookSecret(req, settings)) lingerAfterError(req, res)
      else closeAfterResponse(req, res)
      res.status(413).json({ ok: false, error: 'payload_too_large' })
      return
    }
    let parser = parsers.get(limit)
    if (!parser) {
      parser = express.json({ limit })
      parsers.set(limit, parser)
    }
    parser(req, res, next)
  }
}
