import type Database from 'better-sqlite3'

/** Tag à créer dans la transaction d'enqueue (déjà validé par l'appelant). */
export interface NewTag {
  name: string
  description: string
  createdBy: string
  needsDescription?: boolean
}

/**
 * Crée les tags absents du registre (sans toucher à ceux qui existent). À appeler DANS la transaction
 * d'enqueue : si l'envoi échoue, aucun tag orphelin ne reste.
 */
export function createTags(db: Database.Database, tags: readonly NewTag[], now: number): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO tags (name, description, created_by, created_at, needs_description)
     VALUES (?, ?, ?, ?, ?)`,
  )
  for (const t of tags)
    insert.run(t.name, t.description, t.createdBy, now, t.needsDescription ? 1 : 0)
}

/** Pose des tags (existants : clé étrangère) ; `usage_count`/`last_used_at` à chaque nouvelle pose. */
export function attachTags(
  db: Database.Database,
  messageId: string,
  names: readonly string[],
  now: number,
): void {
  const insert = db.prepare('INSERT OR IGNORE INTO message_tags (message_id, tag) VALUES (?, ?)')
  const bump = db.prepare(
    'UPDATE tags SET usage_count = usage_count + 1, last_used_at = ? WHERE name = ?',
  )
  for (const name of new Set(names)) {
    if (insert.run(messageId, name).changes > 0) bump.run(now, name)
  }
}
