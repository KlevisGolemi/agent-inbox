import { describe, expect, it, vi } from 'vitest'
import { createAdmin, resetPassword } from '../src/cli.js'
import { hashPassword, verifyPassword } from '../src/auth/password.js'
import { createAdminSessions } from '../src/auth/sessions.js'
import { createSetupCode, ensureAdmin } from '../src/auth/setup.js'
import { randomToken, sha256 } from '../src/auth/tokens.js'
import { createUsers, isValidEmail } from '../src/auth/users.js'
import { escapeHtml, renderPage } from '../src/auth/views.js'
import { testDb, testEnv } from './helpers/app.js'

const PW = 'correct horse battery'

describe('hashPassword / verifyPassword', () => {
  it('format scrypt$N$r$p$sel$hash et vérification ok/ko', async () => {
    const stored = await hashPassword(PW)
    const parts = stored.split('$')
    expect(parts.slice(0, 4)).toEqual(['scrypt', '16384', '8', '1'])
    expect(Buffer.from(parts[4]!, 'base64')).toHaveLength(16)
    expect(Buffer.from(parts[5]!, 'base64')).toHaveLength(64)
    expect(await verifyPassword(PW, stored)).toBe(true)
    expect(await verifyPassword(PW + 'x', stored)).toBe(false)
  })

  it('sel aléatoire : deux hachages différents', async () => {
    expect(await hashPassword(PW)).not.toBe(await hashPassword(PW))
  })

  it('valeur stockée malformée → false sans exception', async () => {
    for (const bad of ['', 'scrypt$1$2', 'bcrypt$16384$8$1$AAAA$AAAA', 'scrypt$x$8$1$AAAA$AAAA']) {
      expect(await verifyPassword(PW, bad)).toBe(false)
    }
  })
})

describe('jetons', () => {
  it('randomToken en base64url, longueur selon les octets', () => {
    const t = randomToken(32)
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(randomToken()).not.toBe(randomToken())
  })

  it('sha256 en hex', () => {
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('code de setup : 6 groupes de 4', () => {
    const c = createSetupCode()
    expect(c).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){5}$/)
    expect(createSetupCode()).not.toBe(c)
  })
})

describe('utilisateurs', () => {
  it('create / verify / setPassword ; email insensible à la casse', async () => {
    const users = createUsers(testDb())
    expect(users.count()).toBe(0)
    const u = await users.create('Admin@Example.com', PW)
    expect(u).toMatchObject({ email: 'Admin@Example.com' })
    expect(users.count()).toBe(1)
    expect(await users.verify('admin@example.com', PW)).toMatchObject({ id: u.id })
    expect(await users.verify('admin@example.com', 'mauvais mot de passe')).toBeNull()
    expect(await users.verify('inconnu@example.com', PW)).toBeNull()
    expect(await users.setPassword('admin@example.com', 'nouveau mot de passe')).toBe(true)
    expect(await users.verify('admin@example.com', PW)).toBeNull()
    expect(await users.setPassword('inconnu@example.com', 'nouveau mot de passe')).toBe(false)
  })

  it('refuse un mot de passe de moins de 12 caractères', async () => {
    const users = createUsers(testDb())
    await expect(users.create('a@example.com', 'court')).rejects.toThrow(/12 caractères/)
  })
})

describe('sessions admin', () => {
  it('create → resolve ; stockage du sha256 uniquement ; expiration à 7 j ; destroy', async () => {
    const db = testDb()
    let clock = 1_000_000
    const users = createUsers(db)
    const u = await users.create('a@example.com', PW)
    const sessions = createAdminSessions(db, () => clock)
    const cookie = sessions.create(u.id)
    expect(cookie).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const row = db.prepare('SELECT id_hash, expires_at FROM admin_sessions').get() as {
      id_hash: string
      expires_at: number
    }
    expect(row.id_hash).toBe(sha256(cookie))
    expect(row.expires_at).toBe(clock + 7 * 24 * 3600 * 1000)
    expect(sessions.resolve(cookie)).toMatchObject({ id: u.id, email: 'a@example.com' })
    expect(sessions.resolve(undefined)).toBeNull()
    expect(sessions.resolve('inconnu')).toBeNull()
    clock = row.expires_at - 1
    expect(sessions.resolve(cookie)).not.toBeNull()
    clock = row.expires_at
    expect(sessions.resolve(cookie)).toBeNull()
    clock = 1_000_000
    sessions.destroy(cookie)
    expect(sessions.resolve(cookie)).toBeNull()
  })
})

describe('ensureAdmin', () => {
  it('crée le compte depuis ADMIN_EMAIL/ADMIN_PASSWORD si aucun utilisateur', async () => {
    const users = createUsers(testDb())
    const log = vi.fn()
    const r = await ensureAdmin({
      users,
      env: testEnv({ adminEmail: 'boot@example.com', adminPassword: PW }),
      log,
    })
    expect(r.setupCode).toBeNull()
    expect(await users.verify('boot@example.com', PW)).not.toBeNull()
    expect(JSON.stringify(log.mock.calls)).not.toContain(PW)
  })

  it("n'écrase pas un compte existant", async () => {
    const users = createUsers(testDb())
    await users.create('a@example.com', PW)
    const r = await ensureAdmin({
      users,
      env: testEnv({ adminEmail: 'boot@example.com', adminPassword: 'autre mot de passe' }),
      log: vi.fn(),
    })
    expect(r.setupCode).toBeNull()
    expect(users.count()).toBe(1)
  })

  it('sans compte ni env : génère un code et le journalise en warn avec l’URL', async () => {
    const users = createUsers(testDb())
    const log = vi.fn()
    const r = await ensureAdmin({ users, env: testEnv(), log })
    expect(r.setupCode).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){5}$/)
    expect(log).toHaveBeenCalledWith(
      'warn',
      expect.any(String),
      expect.objectContaining({ url: 'https://queue.example.test/setup', setup_code: r.setupCode }),
    )
  })
})

describe('resetPassword (cli)', () => {
  it('met à jour le mot de passe et supprime toutes les sessions', async () => {
    const db = testDb()
    const users = createUsers(db)
    const u = await users.create('a@example.com', PW)
    const sessions = createAdminSessions(db)
    const cookie = sessions.create(u.id)
    await resetPassword(db, 'a@example.com', 'nouveau mot de passe sûr')
    expect(sessions.resolve(cookie)).toBeNull()
    expect(await users.verify('a@example.com', 'nouveau mot de passe sûr')).not.toBeNull()
  })

  it('révoque tous les jetons OAuth de l’utilisateur', async () => {
    const db = testDb()
    const u = await createUsers(db).create('a@example.com', PW)
    db.prepare("INSERT INTO oauth_clients VALUES ('c', '{}', 0)").run()
    db.prepare(
      "INSERT INTO oauth_tokens VALUES ('t', 'refresh', 'c', ?, 'queue', NULL, ?, 0, 0)",
    ).run(u.id, Date.now() + 3_600_000)
    await resetPassword(db, 'a@example.com', 'nouveau mot de passe sûr')
    expect(db.prepare('SELECT revoked FROM oauth_tokens').get()).toEqual({ revoked: 1 })
  })

  it('refuse un mot de passe court ou un email inconnu', async () => {
    const db = testDb()
    await createUsers(db).create('a@example.com', PW)
    await expect(resetPassword(db, 'a@example.com', 'court')).rejects.toThrow(/12 caractères/)
    await expect(resetPassword(db, 'x@example.com', 'assez long mot de passe')).rejects.toThrow(
      /introuvable/,
    )
  })
})

describe('createAdmin (cli)', () => {
  const TRICKY = `it's "q" $x \\ fin`

  it('crée le premier compte, mot de passe avec caractères spéciaux accepté', async () => {
    const db = testDb()
    await createAdmin(db, 'a@example.com', TRICKY)
    expect(await createUsers(db).verify('a@example.com', TRICKY)).not.toBeNull()
  })

  it('refuse un mot de passe court, et un second compte quand un admin existe', async () => {
    const db = testDb()
    await expect(createAdmin(db, 'a@example.com', 'court')).rejects.toThrow(/12 caractères/)
    expect(createUsers(db).count()).toBe(0)
    await createAdmin(db, 'a@example.com', PW)
    await expect(createAdmin(db, 'b@example.com', PW)).rejects.toThrow(/existe déjà/)
    expect(createUsers(db).count()).toBe(1)
  })
})

describe('validation de l’email', () => {
  it('isValidEmail : forme a@b, sans espace, 254 caractères au plus', () => {
    expect(isValidEmail('a@example.com')).toBe(true)
    for (const bad of ['', 'pas-un-email', 'a b@example.com', '@example.com', 'a@', 'a@b@c']) {
      expect(isValidEmail(bad)).toBe(false)
    }
    expect(isValidEmail(`${'a'.repeat(250)}@b.c`)).toBe(true)
    expect(isValidEmail(`${'a'.repeat(251)}@b.c`)).toBe(false)
  })

  it('create-admin refuse un email invalide sans créer de compte', async () => {
    const db = testDb()
    await expect(createAdmin(db, 'pas-un-email', PW)).rejects.toThrow(/email invalide/i)
    expect(createUsers(db).count()).toBe(0)
  })

  it('ensureAdmin refuse un ADMIN_EMAIL invalide', async () => {
    const users = createUsers(testDb())
    await expect(
      ensureAdmin({
        users,
        env: testEnv({ adminEmail: 'admin', adminPassword: PW }),
        log: vi.fn(),
      }),
    ).rejects.toThrow(/ADMIN_EMAIL/)
    expect(users.count()).toBe(0)
  })
})

describe('vues', () => {
  it('escapeHtml échappe & < > " \'', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    )
  })

  it('renderPage : document autonome, titre échappé, sans ressource externe', () => {
    const html = renderPage('<T>', '<p>corps</p>')
    expect(html).toContain('<html lang="fr">')
    expect(html).toContain('<title>&lt;T&gt; · Cowork Queue</title>')
    expect(html).toContain('<p>corps</p>')
    expect(html).not.toMatch(/<(link|script)\b/)
  })
})
