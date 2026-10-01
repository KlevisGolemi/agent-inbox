import { realpathSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import type Database from 'better-sqlite3'
import { assertPasswordStrength, createUsers } from './auth/users.js'
import { openDb } from './db/index.js'
import { migrate } from './db/migrations.js'

/** Change le mot de passe d'un compte et invalide toutes les sessions admin. */
export async function resetPassword(
  db: Database.Database,
  email: string,
  password: string,
): Promise<void> {
  assertPasswordStrength(password)
  const updated = await createUsers(db).setPassword(email, password)
  if (!updated) throw new Error(`Utilisateur introuvable : ${email}`)
  db.prepare('DELETE FROM admin_sessions').run()
}

/** Saisie masquée sur un terminal (aucun écho). */
function promptHidden(prompt: string): Promise<string> {
  const stdin = process.stdin
  return new Promise((resolve, reject) => {
    process.stderr.write(prompt)
    let value = ''
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    const done = (err?: Error) => {
      stdin.setRawMode(false)
      stdin.pause()
      stdin.off('data', onData)
      process.stderr.write('\n')
      if (err) reject(err)
      else resolve(value)
    }
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done()
        if (ch === '\u0003') return done(new Error('Annulé'))
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1)
        else if (ch >= ' ') value += ch
      }
    }
    stdin.on('data', onData)
  })
}

/** Hors terminal (script) : lit une seule ligne sur stdin. */
function readLine(): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin })
    let line: string | undefined
    rl.once('line', (l) => {
      line = l
      rl.close()
    })
    rl.once('close', () => resolve(line ?? ''))
  })
}

async function readNewPassword(): Promise<string> {
  if (!process.stdin.isTTY) return readLine()
  const first = await promptHidden('Nouveau mot de passe : ')
  const second = await promptHidden('Confirmez le mot de passe : ')
  if (first !== second) throw new Error('Les deux saisies ne correspondent pas')
  return first
}

const USAGE = 'Usage : node dist/cli.js reset-password <email>'

async function main(argv: string[]): Promise<number> {
  const [command, email] = argv
  if (command !== 'reset-password' || !email) {
    process.stderr.write(`${USAGE}\n`)
    return 2
  }
  const password = await readNewPassword()
  const db = openDb(process.env.DB_PATH || '/data/queue.db')
  try {
    migrate(db, () => {})
    await resetPassword(db, email, password)
  } finally {
    db.close()
  }
  process.stdout.write('Mot de passe mis à jour ; toutes les sessions ont été fermées.\n')
  return 0
}

function isEntryPoint(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isEntryPoint()) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(`Erreur : ${err instanceof Error ? err.message : String(err)}\n`)
      process.exit(1)
    },
  )
}
