import type Database from 'better-sqlite3'
import { log as defaultLog, type LogLevel } from '../log.js'

export interface Migration {
  version: number
  up(db: Database.Database): void
}

type LogFn = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void

/** Migration 1 : schéma v1 exact. Fonctionne sur base vierge comme sur base v1 existante. */
function up1(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id          TEXT PRIMARY KEY,
      source      TEXT NOT NULL DEFAULT 'n8n',
      payload     TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'pending',
      created_at  INTEGER NOT NULL,
      read_at     INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_status     ON messages(status);
    CREATE INDEX IF NOT EXISTS idx_created_at ON messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_read_at    ON messages(read_at);
  `)
  const cols = db.prepare('PRAGMA table_info(messages)').all() as { name: string }[]
  if (!cols.some((c) => c.name === 'correlation_id')) {
    db.exec('ALTER TABLE messages ADD COLUMN correlation_id TEXT')
  }
  // Index partiel : N lignes NULL autorisées, unicité sur toute valeur fournie.
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_correlation_id_unique
           ON messages(correlation_id) WHERE correlation_id IS NOT NULL`)
}

/** Migration 2 : réglages, comptes admin, OAuth et clés API. */
function up2(db: Database.Database): void {
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE admin_sessions (id_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL);
    CREATE TABLE oauth_clients (client_id TEXT PRIMARY KEY, metadata TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE oauth_codes (code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL, code_challenge TEXT NOT NULL, redirect_uri TEXT NOT NULL, scopes TEXT NOT NULL,
      resource TEXT, expires_at INTEGER NOT NULL);
    CREATE TABLE oauth_tokens (token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('access','refresh')),
      client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE, user_id INTEGER NOT NULL,
      scopes TEXT NOT NULL, resource TEXT, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    CREATE INDEX idx_oauth_tokens_expires ON oauth_tokens(expires_at);
    CREATE TABLE api_keys (id INTEGER PRIMARY KEY, name TEXT NOT NULL, prefix TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL, last_used_at INTEGER, revoked INTEGER NOT NULL DEFAULT 0);
  `)
}

/** Migration 3 : sujets, bail et tentatives (statuts : pending | leased | read). */
function up3(db: Database.Database): void {
  db.exec(`
    ALTER TABLE messages ADD COLUMN topic TEXT NOT NULL DEFAULT 'default';
    ALTER TABLE messages ADD COLUMN lease_until INTEGER;
    ALTER TABLE messages ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
    CREATE INDEX idx_messages_topic_status_created ON messages(topic, status, created_at);
  `)
}

/** Migration 4 (v2.2) : pièces jointes (contenu sur disque), registre de tags, liens de dépôt. */
function up4(db: Database.Database): void {
  db.exec(`
    -- deleted_reason : expired | consumed (une pièce disparaît avec son message par cascade)
    CREATE TABLE attachments (
      id                  TEXT PRIMARY KEY,
      message_id          TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      filename            TEXT NOT NULL,
      mime_type           TEXT NOT NULL,
      category            TEXT NOT NULL,
      size_bytes          INTEGER NOT NULL,
      sha256              TEXT NOT NULL,
      on_download         TEXT NOT NULL DEFAULT 'keep',
      created_at          INTEGER NOT NULL,
      expires_at          INTEGER NOT NULL,
      downloads           INTEGER NOT NULL DEFAULT 0,
      first_downloaded_at INTEGER,
      deleted_at          INTEGER,
      deleted_reason      TEXT
    );
    CREATE INDEX idx_attachments_message ON attachments(message_id);
    CREATE INDEX idx_attachments_live    ON attachments(expires_at) WHERE deleted_at IS NULL;

    CREATE TABLE tags (
      name              TEXT PRIMARY KEY,
      description       TEXT NOT NULL,
      created_by        TEXT NOT NULL,
      created_at        INTEGER NOT NULL,
      usage_count       INTEGER NOT NULL DEFAULT 0,
      last_used_at      INTEGER,
      needs_description INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE message_tags (
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      tag        TEXT NOT NULL REFERENCES tags(name) ON UPDATE CASCADE ON DELETE CASCADE,
      PRIMARY KEY (message_id, tag)
    );

    CREATE TABLE drops (
      id                 TEXT PRIMARY KEY,
      token_hash         TEXT NOT NULL UNIQUE,
      kind               TEXT NOT NULL,
      label              TEXT NOT NULL,
      topic              TEXT NOT NULL,
      max_files          INTEGER NOT NULL,
      files_count        INTEGER NOT NULL DEFAULT 0,
      max_file_mb        INTEGER NOT NULL,
      allowed_categories TEXT NOT NULL,
      message_payload    TEXT,
      correlation_id     TEXT,
      on_download        TEXT,
      created_by         TEXT NOT NULL,
      created_at         INTEGER NOT NULL,
      expires_at         INTEGER NOT NULL,
      revoked_at         INTEGER
    );
    CREATE TABLE drop_tags (
      drop_id TEXT NOT NULL REFERENCES drops(id) ON DELETE CASCADE,
      tag     TEXT NOT NULL REFERENCES tags(name) ON UPDATE CASCADE ON DELETE CASCADE,
      PRIMARY KEY (drop_id, tag)
    );
    CREATE TABLE drop_events (
      id         INTEGER PRIMARY KEY,
      drop_id    TEXT NOT NULL REFERENCES drops(id) ON DELETE CASCADE,
      at         INTEGER NOT NULL,
      outcome    TEXT NOT NULL,
      files      INTEGER NOT NULL DEFAULT 0,
      bytes      INTEGER NOT NULL DEFAULT 0,
      message_id TEXT
    );

    ALTER TABLE messages ADD COLUMN trust   TEXT NOT NULL DEFAULT 'internal';
    ALTER TABLE messages ADD COLUMN drop_id TEXT;
  `)
}

export const MIGRATIONS: Migration[] = [
  { version: 1, up: up1 },
  { version: 2, up: up2 },
  { version: 3, up: up3 },
  { version: 4, up: up4 },
]

export const LATEST_VERSION = 4

/**
 * Applique les migrations en attente, chacune dans sa propre transaction
 * (user_version inclus : en cas d'erreur, tout est annulé). Renvoie la version atteinte.
 */
export function migrate(
  db: Database.Database,
  logFn: LogFn = defaultLog,
  migrations: Migration[] = MIGRATIONS,
): number {
  let current = db.pragma('user_version', { simple: true }) as number
  for (const m of migrations) {
    if (m.version <= current) continue
    db.transaction(() => {
      m.up(db)
      db.pragma(`user_version = ${m.version}`)
    })()
    logFn('info', 'Migration appliquée', { version: m.version })
    current = m.version
  }
  return current
}
