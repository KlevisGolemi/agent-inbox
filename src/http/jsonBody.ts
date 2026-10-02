import express, { type RequestHandler, type Response } from 'express'
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

/** Réponse 413 commune aux corps JSON trop gros. */
export function sendPayloadTooLarge(res: Response): void {
  res.status(413).json({ ok: false, error: 'payload_too_large' })
}

/** Parseurs `express.json` mémoïsés par valeur de limite (erreurs 413 / 400 existantes conservées). */
function parserCache(): (limit: number) => RequestHandler {
  const parsers = new Map<number, RequestHandler>()
  return (limit) => {
    let parser = parsers.get(limit)
    if (!parser) {
      parser = express.json({ limit })
      parsers.set(limit, parser)
    }
    return parser
  }
}

/**
 * Parseur JSON choisi par requête, monté sur toute l'application. `/mcp` en est exclu : son corps
 * n'est lu qu'après le limiteur et le Bearer, par `createMcpJsonBody`.
 */
export function createJsonBody(settings: Settings): RequestHandler {
  const parserFor = parserCache()
  return (req, res, next) => {
    if (req.path === '/mcp') {
      next()
      return
    }
    const limit = jsonLimitFor(req.path, settings)
    // Corps JSON annoncé trop gros : refus immédiat (express.json le lirait en entier avant de
    // répondre). Producteur authentifié (secret webhook valide) : lingering borné pour qu'il lise
    // bien le 413 ; sinon fermeture immédiate, rien n'est lu pour un inconnu.
    if (req.is('application/json') && Number(req.headers['content-length']) > limit) {
      if (req.path === '/webhook' && checkWebhookSecret(req, settings)) lingerAfterError(req, res)
      else closeAfterResponse(req, res)
      sendPayloadTooLarge(res)
      return
    }
    parserFor(limit)(req, res, next)
  }
}

/**
 * Parseur JSON de `POST /mcp`, placé après le limiteur et le Bearer : un appelant anonyme
 * (même en chunked) n'a jamais son corps lu. Corps annoncé trop gros : 413 sans lecture.
 */
export function createMcpJsonBody(settings: Settings): RequestHandler {
  const parserFor = parserCache()
  return (req, res, next) => {
    const limit = jsonLimitFor('/mcp', settings)
    if (req.is('application/json') && Number(req.headers['content-length']) > limit) {
      sendPayloadTooLarge(res)
      return
    }
    parserFor(limit)(req, res, next)
  }
}
