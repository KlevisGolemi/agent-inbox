import type Database from 'better-sqlite3'
import type { Response } from 'express'
import {
  InvalidGrantError,
  InvalidScopeError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js'
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from '@modelcontextprotocol/sdk/server/auth/provider.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import type { Env } from '../../env.js'
import { log } from '../../log.js'
import { SESSION_COOKIE, type AdminSessions } from '../sessions.js'
import { randomToken, sha256 } from '../tokens.js'
import { SqliteClientsStore } from './clientsStore.js'

export const SUPPORTED_SCOPES = ['queue']
export const ACCESS_TOKEN_TTL_MS = 3600_000
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 3600_000
export const AUTH_CODE_TTL_MS = 10 * 60_000
export const CONSENT_TTL_MS = 10 * 60_000
/** Borne mémoire des demandes de consentement en attente (au-delà : les plus anciennes sautent). */
const MAX_PENDING = 1000
// randomToken(32) → 43 caractères base64url ; tout le reste est refusé sans toucher la base.
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/

/** Demande /authorize validée, en attente de la décision de l'administrateur. */
export interface PendingAuthorization {
  clientId: string
  clientName: string
  redirectUri: string
  codeChallenge: string
  scopes: string[]
  state?: string
  resource?: string
  expiresAt: number
}

export interface OAuthProviderDeps {
  db: Database.Database
  sessions: AdminSessions
  env: Env
  now?: () => number
}

interface CodeRow {
  client_id: string
  user_id: number
  code_challenge: string
  redirect_uri: string
  scopes: string
  resource: string | null
  expires_at: number
}

interface TokenRow {
  client_id: string
  user_id: number
  scopes: string
  resource: string | null
  expires_at: number
  revoked: number
}

/** Scopes demandés (vides ignorés) ; défaut `queue` ; tout scope inconnu est refusé. */
function resolveScopes(requested: string[] | undefined): string[] {
  const scopes = [...new Set((requested ?? []).filter((s) => s !== ''))]
  if (scopes.length === 0) return [...SUPPORTED_SCOPES]
  const unknown = scopes.filter((s) => !SUPPORTED_SCOPES.includes(s))
  if (unknown.length > 0)
    throw new InvalidScopeError(`Scope non pris en charge : ${unknown.join(' ')}`)
  return scopes
}

/**
 * Serveur d'autorisation OAuth 2.1 adossé à SQLite : codes et jetons stockés en SHA-256,
 * code à usage unique (10 min), access 1 h, refresh 30 j avec rotation et détection de
 * réutilisation. Expiré dès que now >= expires_at.
 */
export class SqliteOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: SqliteClientsStore
  private readonly now: () => number
  private readonly sessions: AdminSessions
  // Demandes de consentement en mémoire, propres à ce processus : conception mono-instance
  // (un redémarrage oblige seulement à relancer la connexion depuis le client).
  private readonly pending = new Map<string, PendingAuthorization>()
  private readonly stmts

  constructor(deps: OAuthProviderDeps) {
    const { db } = deps
    this.now = deps.now ?? Date.now
    this.sessions = deps.sessions
    this.clientsStore = new SqliteClientsStore(db, this.now)
    this.stmts = {
      insertCode: db.prepare(
        `INSERT INTO oauth_codes (code_hash, client_id, user_id, code_challenge, redirect_uri, scopes, resource, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      purgeCodes: db.prepare('DELETE FROM oauth_codes WHERE expires_at <= ?'),
      selectCode: db.prepare(
        'SELECT client_id, code_challenge, expires_at FROM oauth_codes WHERE code_hash = ?',
      ),
      consumeCode: db.prepare('DELETE FROM oauth_codes WHERE code_hash = ? RETURNING *'),
      insertToken: db.prepare(
        `INSERT INTO oauth_tokens (token_hash, kind, client_id, user_id, scopes, resource, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      selectToken: db.prepare(
        `SELECT client_id, user_id, scopes, resource, expires_at, revoked
         FROM oauth_tokens WHERE token_hash = ? AND kind = ?`,
      ),
      revokeToken: db.prepare(
        'UPDATE oauth_tokens SET revoked = 1 WHERE token_hash = ? AND client_id = ? AND revoked = 0',
      ),
      revokeFamily: db.prepare(
        'UPDATE oauth_tokens SET revoked = 1 WHERE client_id = ? AND user_id = ? AND revoked = 0',
      ),
    }
    this.exchangeCodeTx = db.transaction(this.exchangeCodeTx.bind(this))
    this.rotateRefreshTx = db.transaction(this.rotateRefreshTx.bind(this))
  }

  // ---------------------------------------------------------------- autorisation

  /**
   * Appelé par le routeur SDK une fois client_id, redirect_uri (enregistrée) et PKCE S256
   * validés. Mémorise la demande puis envoie vers la page de consentement (via /login si
   * aucune session admin).
   */
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const scopes = resolveScopes(params.scopes)
    const t = this.now()
    for (const [id, p] of this.pending) if (t >= p.expiresAt) this.pending.delete(id)
    while (this.pending.size >= MAX_PENDING) {
      const oldest = this.pending.keys().next().value
      if (oldest === undefined) break
      this.pending.delete(oldest)
    }
    const id = randomToken(16)
    this.pending.set(id, {
      clientId: client.client_id,
      clientName: (client.client_name?.trim() || client.client_id).slice(0, 100),
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      scopes,
      state: params.state,
      resource: params.resource?.href,
      expiresAt: t + CONSENT_TTL_MS,
    })
    const consentPath = `/oauth/consent?req=${id}`
    const cookies = res.req.cookies as Record<string, unknown> | undefined
    const cookie = cookies?.[SESSION_COOKIE]
    const user = this.sessions.resolve(typeof cookie === 'string' ? cookie : undefined)
    res.redirect(302, user ? consentPath : `/login?next=${encodeURIComponent(consentPath)}`)
  }

  /** Demande en attente non expirée, ou undefined. */
  getPending(id: string): PendingAuthorization | undefined {
    const p = this.pending.get(id)
    if (p && this.now() >= p.expiresAt) {
      this.pending.delete(id)
      return undefined
    }
    return p
  }

  /**
   * Consomme la demande (usage unique) et renvoie l'URL de redirection : code + state si
   * accordé, error=access_denied sinon. null si la demande est inconnue, expirée ou si le
   * client a disparu.
   */
  async completeAuthorization(id: string, userId: number, allow: boolean): Promise<string | null> {
    const p = this.getPending(id)
    if (!p) return null
    this.pending.delete(id)
    if (!(await this.clientsStore.getClient(p.clientId))) return null

    const url = new URL(p.redirectUri)
    if (allow) {
      const code = randomToken(32)
      const t = this.now()
      this.stmts.purgeCodes.run(t)
      this.stmts.insertCode.run(
        sha256(code),
        p.clientId,
        userId,
        p.codeChallenge,
        p.redirectUri,
        p.scopes.join(' '),
        p.resource ?? null,
        t + AUTH_CODE_TTL_MS,
      )
      url.searchParams.set('code', code)
    } else {
      url.searchParams.set('error', 'access_denied')
      url.searchParams.set('error_description', 'L’administrateur a refusé l’accès.')
    }
    if (p.state !== undefined) url.searchParams.set('state', p.state)
    return url.href
  }

  // ---------------------------------------------------------------- codes

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const row = TOKEN_RE.test(authorizationCode)
      ? (this.stmts.selectCode.get(sha256(authorizationCode)) as
          Pick<CodeRow, 'client_id' | 'code_challenge' | 'expires_at'> | undefined)
      : undefined
    if (!row || row.client_id !== client.client_id || this.now() >= row.expires_at) {
      throw new InvalidGrantError('Code d’autorisation invalide ou expiré')
    }
    return row.code_challenge
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const tokens = this.exchangeCodeTx(client.client_id, authorizationCode, redirectUri, resource)
    if (!tokens) throw new InvalidGrantError('Code d’autorisation invalide ou expiré')
    log('info', 'Jetons OAuth émis', { client_id: client.client_id })
    return tokens
  }

  /** Transaction : le code est supprimé (usage unique) avant toute vérification. */
  private exchangeCodeTx(
    clientId: string,
    code: string,
    redirectUri: string | undefined,
    resource: URL | undefined,
  ): OAuthTokens | null {
    if (!TOKEN_RE.test(code)) return null
    const row = this.stmts.consumeCode.get(sha256(code)) as CodeRow | undefined
    if (
      !row ||
      row.client_id !== clientId ||
      this.now() >= row.expires_at ||
      (redirectUri !== undefined && redirectUri !== row.redirect_uri) ||
      (resource !== undefined && row.resource !== null && resource.href !== row.resource)
    ) {
      return null
    }
    return this.issueTokens(row.client_id, row.user_id, row.scopes.split(' '), row.resource)
  }

  // ---------------------------------------------------------------- jetons

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
  ): Promise<OAuthTokens> {
    const out = this.rotateRefreshTx(client.client_id, refreshToken, scopes)
    if (out === 'reused') {
      log('warn', 'Refresh token réutilisé : jetons du client révoqués', {
        client_id: client.client_id,
      })
    }
    if (out === 'invalid_scope') throw new InvalidScopeError('Scope plus large que l’autorisation')
    if (typeof out === 'string') throw new InvalidGrantError('Refresh token invalide ou expiré')
    return out
  }

  /**
   * Transaction : révoque l'ancien refresh et émet une nouvelle paire. Un refresh déjà révoqué
   * révoque toute la famille client + utilisateur (détection de réutilisation). On ne lève pas
   * ici : une exception annulerait la révocation.
   */
  private rotateRefreshTx(
    clientId: string,
    refreshToken: string,
    requested: string[] | undefined,
  ): OAuthTokens | 'invalid' | 'reused' | 'invalid_scope' {
    if (!TOKEN_RE.test(refreshToken)) return 'invalid'
    const hash = sha256(refreshToken)
    const row = this.stmts.selectToken.get(hash, 'refresh') as TokenRow | undefined
    if (!row || row.client_id !== clientId) return 'invalid'
    if (row.revoked === 1) {
      this.stmts.revokeFamily.run(row.client_id, row.user_id)
      return 'reused'
    }
    if (this.now() >= row.expires_at) return 'invalid'
    const granted = row.scopes.split(' ')
    const wanted = (requested ?? []).filter((s) => s !== '')
    if (wanted.some((s) => !granted.includes(s))) return 'invalid_scope'
    if (this.stmts.revokeToken.run(hash, clientId).changes !== 1) return 'invalid'
    return this.issueTokens(
      row.client_id,
      row.user_id,
      wanted.length > 0 ? wanted : granted,
      row.resource,
    )
  }

  private issueTokens(
    clientId: string,
    userId: number,
    scopes: string[],
    resource: string | null,
  ): OAuthTokens {
    const access = randomToken(32)
    const refresh = randomToken(32)
    const t = this.now()
    const scope = scopes.join(' ')
    const ins = this.stmts.insertToken
    ins.run(sha256(access), 'access', clientId, userId, scope, resource, t + ACCESS_TOKEN_TTL_MS, t)
    ins.run(
      sha256(refresh),
      'refresh',
      clientId,
      userId,
      scope,
      resource,
      t + REFRESH_TOKEN_TTL_MS,
      t,
    )
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_MS / 1000,
      refresh_token: refresh,
      scope,
    }
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const row =
      typeof token === 'string' && TOKEN_RE.test(token)
        ? (this.stmts.selectToken.get(sha256(token), 'access') as TokenRow | undefined)
        : undefined
    if (!row || row.revoked === 1 || this.now() >= row.expires_at) {
      throw new InvalidTokenError('Jeton invalide, expiré ou révoqué')
    }
    return {
      token,
      clientId: row.client_id,
      scopes: row.scopes.split(' '),
      expiresAt: Math.floor(row.expires_at / 1000),
      resource: row.resource ? new URL(row.resource) : undefined,
      extra: { userId: row.user_id },
    }
  }

  /** RFC 7009 : jeton inconnu, déjà révoqué ou d'un autre client → aucun effet. */
  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    if (!TOKEN_RE.test(request.token)) return
    this.stmts.revokeToken.run(sha256(request.token), client.client_id)
  }
}
