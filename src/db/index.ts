import Database from 'better-sqlite3'

/** Ouvre la base SQLite avec les réglages de fiabilité attendus (WAL, clés étrangères, attente de verrou). */
export function openDb(path: string): Database.Database {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  return db
}
