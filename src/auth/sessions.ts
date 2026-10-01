import type Database from 'better-sqlite3'
import type { CookieOptions, RequestHandler } from 'express'
import type { Env } from '../env.js'
import { randomToken, sha256 } from './tokens.js'
import type { User } from './users.js'

export const SESSION_COOKIE = 'cq_session'
export const SESSION_TTL_MS = 7 * 24 * 3600 * 1000

export interface AdminSessions {
  /** Crée une session ; renvoie la valeur du cookie (seul son sha256 est stocké). */
  create(userId: number): string
  /** null si le cookie est absent, inconnu ou expiré (expirée dès que now >= expires_at). */
  resolve(cookie?: string): User | null
  destroy(cookie?: string): void
  /** Supprime toutes les sessions de l'utilisateur sauf celle du cookie donné. */
  destroyOthers(userId: number, keepCookie?: string): void
}

// randomToken(32) → 43 caractères base64url ; on refuse tout le reste sans toucher la base.
const COOKIE_RE = /^[A-Za-z0-9_-]{43}$/

export function createAdminSessions(
  db: Database.Database,
  now: () => number = Date.now,
): AdminSessions {
  const insert = db.prepare(
    'INSERT INTO admin_sessions (id_hash, user_id, expires_at) VALUES (?, ?, ?)',
  )
  const select = db.prepare(
    `SELECT u.id, u.email FROM admin_sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id_hash = ? AND s.expires_at > ?`,
  )
  const remove = db.prepare('DELETE FROM admin_sessions WHERE id_hash = ?')
  const removeOthers = db.prepare('DELETE FROM admin_sessions WHERE user_id = ? AND id_hash != ?')

  return {
    create(userId) {
      const token = randomToken(32)
      insert.run(sha256(token), userId, now() + SESSION_TTL_MS)
      return token
    },
    resolve(cookie) {
      if (typeof cookie !== 'string' || !COOKIE_RE.test(cookie)) return null
      const row = select.get(sha256(cookie), now()) as User | undefined
      return row ? { id: row.id, email: row.email } : null
    },
    destroy(cookie) {
      if (typeof cookie !== 'string' || !COOKIE_RE.test(cookie)) return
      remove.run(sha256(cookie))
    },
    destroyOthers(userId, keepCookie) {
      // Sans cookie valide à conserver, '' ne correspond à aucun id_hash : tout est supprimé.
      const keep =
        typeof keepCookie === 'string' && COOKIE_RE.test(keepCookie) ? sha256(keepCookie) : ''
      removeOthers.run(userId, keep)
    },
  }
}

/** Attributs communs des cookies : Secure partout sauf en développement. */
export function baseCookieOptions(env: Env): CookieOptions {
  return { httpOnly: true, secure: env.nodeEnv !== 'development', path: '/' }
}

export function sessionCookieOptions(env: Env): CookieOptions {
  return { ...baseCookieOptions(env), sameSite: 'lax', maxAge: SESSION_TTL_MS }
}

/**
 * Exige une session admin. Navigateur (HTML) → 302 vers la page de connexion avec `next` ;
 * API (JSON) → 401. L'utilisateur est exposé dans `res.locals.user`.
 */
export function requireAdminSession(
  sessions: AdminSessions,
  opts: { redirectTo?: string; json?: boolean } = {},
): RequestHandler {
  const loginPath = opts.redirectTo ?? '/login'
  return (req, res, next) => {
    const user = sessions.resolve(
      (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE],
    )
    if (user) {
      res.locals.user = user
      next()
      return
    }
    if (!opts.json && req.accepts(['json', 'html']) === 'html') {
      res.redirect(302, `${loginPath}?next=${encodeURIComponent(req.originalUrl)}`)
    } else {
      res.status(401).json({ ok: false, error: 'unauthorized', message: 'Session requise' })
    }
  }
}
