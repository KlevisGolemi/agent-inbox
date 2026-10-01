import type { RequestHandler } from 'express'
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js'
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js'
import { getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js'
import type { Env } from '../env.js'
import type { ApiKeys } from './apiKeys.js'
import { SUPPORTED_SCOPES } from './oauth/provider.js'

export interface BearerDeps {
  provider: OAuthTokenVerifier
  apiKeys: Pick<ApiKeys, 'verify'>
  resourceMetadataUrl: string
}

/** URL des métadonnées de la ressource protégée /mcp (RFC 9728), annoncée dans WWW-Authenticate. */
export function mcpResourceMetadataUrl(env: Env): string {
  return getOAuthProtectedResourceMetadataUrl(new URL('/mcp', env.publicUrl))
}

const API_KEY_HEADER = /^Bearer\s+(cwk_\S*)$/i

/**
 * `Authorization: Bearer cwk_…` → clé API (clientId `api-key:<id>`, scope `queue`) ;
 * tout autre Bearer → jeton OAuth vérifié par le SDK. Tout refus → 401 avec
 * `WWW-Authenticate: Bearer … resource_metadata="…"` pour la découverte OAuth.
 */
export function createBearerMiddleware({
  provider,
  apiKeys,
  resourceMetadataUrl,
}: BearerDeps): RequestHandler {
  const oauth = requireBearerAuth({
    verifier: provider,
    requiredScopes: SUPPORTED_SCOPES,
    resourceMetadataUrl,
  })
  return (req, res, next) => {
    const m = API_KEY_HEADER.exec(req.headers.authorization ?? '')
    if (!m) {
      void oauth(req, res, next)
      return
    }
    const token = m[1]!
    const key = apiKeys.verify(token)
    if (!key) {
      // En-tête en ASCII ; le corps JSON porte le message complet.
      res.set(
        'WWW-Authenticate',
        `Bearer error="invalid_token", error_description="Cle API invalide ou revoquee", scope="${SUPPORTED_SCOPES.join(' ')}", resource_metadata="${resourceMetadataUrl}"`,
      )
      res.status(401).json(new InvalidTokenError('Clé API invalide ou révoquée').toResponseObject())
      return
    }
    req.auth = { token, clientId: `api-key:${key.id}`, scopes: [...SUPPORTED_SCOPES] }
    next()
  }
}
