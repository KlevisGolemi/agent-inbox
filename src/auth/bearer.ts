import type { RequestHandler } from 'express'
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

const API_KEY_HEADER = /^Bearer\s+(aik_\S*)$/i

/**
 * `Authorization: Bearer aik_…` → clé API (clientId `api-key:<id>`, scope `queue`) ;
 * sinon → jeton OAuth vérifié par le SDK. Tout refus → 401 (SDK) avec
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
    // Un jeton OAuth (base64url) peut lui aussi commencer par `aik_` : si ce n'est pas une
    // clé API valide, on passe au vérificateur OAuth, seule source des 401.
    const token = API_KEY_HEADER.exec(req.headers.authorization ?? '')?.[1]
    const key = token === undefined ? null : apiKeys.verify(token)
    if (token === undefined || !key) {
      void oauth(req, res, next)
      return
    }
    req.auth = { token, clientId: `api-key:${key.id}`, scopes: [...SUPPORTED_SCOPES] }
    next()
  }
}
