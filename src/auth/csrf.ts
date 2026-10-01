import type { Request, RequestHandler, Response } from 'express'
import type { Env } from '../env.js'
import { baseCookieOptions } from './sessions.js'
import { randomToken, safeEqual } from './tokens.js'
import { sendPage } from './views.js'

export const CSRF_COOKIE = 'cq_csrf'
export const CSRF_FIELD = '_csrf'
export const CSRF_HEADER = 'x-csrf-token'

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/

/**
 * Jeton double-submit : réutilise le cookie existant s'il est bien formé, sinon en crée un.
 * Le cookie est (re)posé ; la valeur renvoyée va dans le champ caché du formulaire.
 */
export function issueCsrfToken(req: Request, res: Response, env: Env): string {
  const existing = (req.cookies as Record<string, unknown> | undefined)?.[CSRF_COOKIE]
  const token = typeof existing === 'string' && TOKEN_RE.test(existing) ? existing : randomToken(32)
  res.cookie(CSRF_COOKIE, token, { ...baseCookieOptions(env), sameSite: 'strict' })
  return token
}

/**
 * Vérifie le jeton CSRF : champ `_csrf` du corps (formulaires) ou en-tête `x-csrf-token` (API),
 * comparé à temps constant au cookie `cq_csrf`. Sinon 403.
 */
function csrfMatches(req: Request): boolean {
  const cookie = (req.cookies as Record<string, unknown> | undefined)?.[CSRF_COOKIE]
  const body = req.body as Record<string, unknown> | undefined
  const sent = body?.[CSRF_FIELD] ?? req.get(CSRF_HEADER)
  return (
    typeof cookie === 'string' &&
    TOKEN_RE.test(cookie) &&
    typeof sent === 'string' &&
    safeEqual(sent, cookie)
  )
}

/** Variante API : échec toujours en JSON (jamais de page HTML), quel que soit l'en-tête Accept. */
export const requireCsrfJson: RequestHandler = (req, res, next) => {
  if (csrfMatches(req)) {
    next()
    return
  }
  res.status(403).json({ ok: false, error: 'csrf', message: 'Jeton CSRF manquant ou invalide.' })
}

export const requireCsrf: RequestHandler = (req, res, next) => {
  if (csrfMatches(req)) {
    next()
    return
  }
  if (req.accepts(['json', 'html']) === 'html') {
    sendPage(
      res,
      403,
      'Requête refusée',
      '<p>Le formulaire a expiré ou est invalide. Rechargez la page et réessayez.</p>',
    )
  } else {
    res.status(403).json({ ok: false, error: 'csrf', message: 'Jeton CSRF manquant ou invalide.' })
  }
}
