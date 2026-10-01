import express, { Router, type Request, type Response } from 'express'
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js'
import type { Env } from '../../env.js'
import { log } from '../../log.js'
import { issueCsrfToken, requireCsrf } from '../csrf.js'
import { SESSION_COOKIE, type AdminSessions } from '../sessions.js'
import type { User } from '../users.js'
import { consentBody, sendPage } from '../views.js'
import { SUPPORTED_SCOPES, type SqliteOAuthProvider } from './provider.js'

export interface OAuthRouterDeps {
  provider: SqliteOAuthProvider
  sessions: AdminSessions
  env: Env
}

/** 10 requêtes/min/IP sur /token et /register. */
const STRICT_RATE_LIMIT = { windowMs: 60_000, limit: 10 }
const REQ_RE = /^[A-Za-z0-9_-]{22}$/

const INVALID_REQUEST =
  '<p>Cette demande d’autorisation est invalide ou a expiré. Relancez la connexion depuis votre client (Claude, ChatGPT…).</p>'

/**
 * Routeur OAuth monté à la racine : endpoints SDK (/authorize, /token, /register, /revoke,
 * métadonnées /.well-known/*) et page de consentement /oauth/consent.
 */
export function createOAuthRouter({ provider, sessions, env }: OAuthRouterDeps): Router {
  const router = Router()

  router.use(
    mcpAuthRouter({
      provider,
      issuerUrl: env.publicUrl,
      resourceServerUrl: new URL('/mcp', env.publicUrl),
      scopesSupported: SUPPORTED_SCOPES,
      resourceName: 'Agent Inbox',
      tokenOptions: { rateLimit: STRICT_RATE_LIMIT },
      // Secret client sans expiration : un connecteur n'a aucun moyen de se réenregistrer seul.
      clientRegistrationOptions: { rateLimit: STRICT_RATE_LIMIT, clientSecretExpirySeconds: 0 },
    }),
  )

  const sessionUser = (req: Request): User | null => {
    const v = (req.cookies as Record<string, unknown> | undefined)?.[SESSION_COOKIE]
    return sessions.resolve(typeof v === 'string' ? v : undefined)
  }

  const reqId = (v: unknown): string => (typeof v === 'string' && REQ_RE.test(v) ? v : '')

  const toLogin = (res: Response, id: string) => {
    res.redirect(302, `/login?next=${encodeURIComponent(`/oauth/consent?req=${id}`)}`)
  }

  router.get('/oauth/consent', (req, res) => {
    const id = reqId(req.query.req)
    // Demande invalide ou inconnue : 400 tout de suite, inutile de passer par /login.
    const pending = id ? provider.getPending(id) : undefined
    if (!pending) {
      sendPage(res, 400, 'Autorisation impossible', INVALID_REQUEST)
      return
    }
    if (!sessionUser(req)) {
      toLogin(res, id)
      return
    }
    const redirect = new URL(pending.redirectUri)
    sendPage(
      res,
      200,
      'Autoriser l’accès',
      consentBody({
        csrf: issueCsrfToken(req, res, env),
        req: id,
        clientName: pending.clientName,
        redirectHost: redirect.host,
        scopes: pending.scopes,
      }),
      // La redirection 302 qui suit le POST est elle aussi soumise à form-action.
      { formAction: [redirect.origin] },
    )
  })

  router.post(
    '/oauth/consent',
    express.urlencoded({ extended: false, limit: '16kb' }),
    (req, res, next) => {
      const user = sessionUser(req)
      if (!user) {
        toLogin(res, reqId((req.body as Record<string, unknown> | undefined)?.req))
        return
      }
      res.locals.user = user
      next()
    },
    requireCsrf,
    async (req, res) => {
      const body = req.body as Record<string, unknown>
      const id = reqId(body.req)
      const decision = body.decision
      if (!id || (decision !== 'allow' && decision !== 'deny')) {
        sendPage(res, 400, 'Autorisation impossible', INVALID_REQUEST)
        return
      }
      const user = res.locals.user as User
      const clientId = provider.getPending(id)?.clientId
      const target = await provider.completeAuthorization(id, user.id, decision === 'allow')
      if (!target) {
        sendPage(res, 400, 'Autorisation impossible', INVALID_REQUEST)
        return
      }
      log('info', 'Consentement OAuth', { client_id: clientId, decision, user_id: user.id })
      res.redirect(302, target)
    },
  )

  return router
}
