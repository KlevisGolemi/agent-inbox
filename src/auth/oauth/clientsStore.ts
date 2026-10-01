import type Database from 'better-sqlite3'
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js'
import { CustomOAuthError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js'
import { randomToken } from '../tokens.js'

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * URI de redirection acceptée à l'enregistrement : https, ou http vers une adresse loopback
 * (clients natifs / CLI comme Claude Code, RFC 8252). Jamais de fragment.
 */
export function isAllowedRedirectUri(uri: string): boolean {
  let u: URL
  try {
    u = new URL(uri)
  } catch {
    return false
  }
  if (u.hash || u.username || u.password) return false
  if (u.protocol === 'https:') return true
  return u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname)
}

/** Clients OAuth enregistrés dynamiquement (RFC 7591), métadonnées en JSON dans oauth_clients. */
export class SqliteClientsStore implements OAuthRegisteredClientsStore {
  private readonly select: Database.Statement
  private readonly insert: Database.Statement

  constructor(
    db: Database.Database,
    private readonly now: () => number = Date.now,
  ) {
    this.select = db.prepare('SELECT metadata FROM oauth_clients WHERE client_id = ?')
    this.insert = db.prepare(
      'INSERT INTO oauth_clients (client_id, metadata, created_at) VALUES (?, ?, ?)',
    )
  }

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    if (typeof clientId !== 'string' || clientId.length > 128) return undefined
    const row = this.select.get(clientId) as { metadata: string } | undefined
    return row ? (JSON.parse(row.metadata) as OAuthClientInformationFull) : undefined
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>,
  ): OAuthClientInformationFull {
    const bad = client.redirect_uris.find((uri) => !isAllowedRedirectUri(uri))
    if (client.redirect_uris.length === 0 || bad !== undefined) {
      throw new CustomOAuthError(
        'invalid_redirect_uri',
        'Les redirect_uris doivent être en https (ou http vers localhost / 127.0.0.1).',
      )
    }
    const t = this.now()
    const full: OAuthClientInformationFull = {
      ...client,
      client_id: randomToken(16),
      client_id_issued_at: Math.floor(t / 1000),
    }
    this.insert.run(full.client_id, JSON.stringify(full), t)
    return full
  }
}
