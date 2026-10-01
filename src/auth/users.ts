import type Database from 'better-sqlite3'
import {
  hashPassword,
  MIN_PASSWORD_LENGTH,
  PASSWORD_TOO_SHORT,
  verifyPassword,
} from './password.js'

export interface User {
  id: number
  email: string
}

export interface Users {
  count(): number
  /** Lève une erreur si le mot de passe est trop court ou si l'email existe déjà. */
  create(email: string, pw: string): Promise<User>
  /** Renvoie l'utilisateur si email + mot de passe sont corrects, sinon null. */
  verify(email: string, pw: string): Promise<User | null>
  /** Renvoie false si l'email est inconnu. */
  setPassword(email: string, pw: string): Promise<boolean>
}

/** Forme minimale d'une adresse email (une seule source : setup, create-admin, ADMIN_EMAIL). */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+$/

export function isValidEmail(email: string): boolean {
  return email.length <= 254 && EMAIL_RE.test(email)
}

export function assertPasswordStrength(pw: string): void {
  if (pw.length < MIN_PASSWORD_LENGTH) throw new Error(PASSWORD_TOO_SHORT)
}

export function createUsers(db: Database.Database, now: () => number = Date.now): Users {
  const countStmt = db.prepare('SELECT COUNT(*) AS n FROM users')
  const insertStmt = db.prepare(
    'INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)',
  )
  const byEmail = db.prepare('SELECT id, email, password_hash FROM users WHERE email = ?')
  const updatePw = db.prepare('UPDATE users SET password_hash = ? WHERE email = ?')

  // Hachage factice : un email inconnu coûte autant qu'un mauvais mot de passe.
  let dummyHash: Promise<string> | undefined

  return {
    count() {
      return (countStmt.get() as { n: number }).n
    },
    async create(email, pw) {
      assertPasswordStrength(pw)
      const hash = await hashPassword(pw)
      const info = insertStmt.run(email, hash, now())
      return { id: Number(info.lastInsertRowid), email }
    },
    async verify(email, pw) {
      const row = byEmail.get(email) as
        { id: number; email: string; password_hash: string } | undefined
      if (!row) {
        dummyHash ??= hashPassword('mot de passe factice')
        await verifyPassword(pw, await dummyHash)
        return null
      }
      return (await verifyPassword(pw, row.password_hash)) ? { id: row.id, email: row.email } : null
    },
    async setPassword(email, pw) {
      assertPasswordStrength(pw)
      const hash = await hashPassword(pw)
      return updatePw.run(hash, email).changes > 0
    },
  }
}
