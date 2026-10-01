import Database from 'better-sqlite3'

/** Crée une base au schéma v1 d'avant le commit 2362f04 (sans correlation_id) avec 3 messages. */
export function makeV1Db(path: string): void {
  const db = new Database(path)
  db.exec(`
    CREATE TABLE messages (
      id          TEXT PRIMARY KEY,
      source      TEXT NOT NULL DEFAULT 'n8n',
      payload     TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'pending',
      created_at  INTEGER NOT NULL,
      read_at     INTEGER
    );
    CREATE INDEX idx_status     ON messages(status);
    CREATE INDEX idx_created_at ON messages(created_at);
    CREATE INDEX idx_read_at    ON messages(read_at);
  `)
  const insert = db.prepare(
    'INSERT INTO messages (id, source, payload, status, created_at, read_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
  insert.run('m1', 'n8n', '{"a":1}', 'pending', 1000, null)
  insert.run('m2', 'zapier', '{"b":2}', 'pending', 2000, null)
  insert.run('m3', 'n8n', '{"c":3}', 'read', 3000, 4000)
  db.close()
}
