import express, { Router, type Request, type RequestHandler } from 'express'
import { rateLimit } from 'express-rate-limit'
import type { Env } from '../env.js'
import { log } from '../log.js'
import { issueCsrfToken, requireCsrf } from './csrf.js'
import { PASSWORD_TOO_SHORT, MIN_PASSWORD_LENGTH } from './password.js'
import {
  baseCookieOptions,
  SESSION_COOKIE,
  sessionCookieOptions,
  type AdminSessions,
} from './sessions.js'
import { normalizeSetupCode } from './setup.js'
import { safeEqual } from './tokens.js'
import { isValidEmail, type Users } from './users.js'
import { loginBody, sendPage, setupBody } from './views.js'

export interface AuthPagesDeps {
  users: Users
  sessions: AdminSessions
  /** Code de setup courant ; null une fois utilisé ou si un compte existe. */
  setupCode: { value: string | null }
  env: Env
}

const DEFAULT_NEXT = '/admin'
const LOGIN_FAILED = 'Email ou mot de passe incorrect.'

/**
 * `next` n'est suivi que s'il s'agit d'un chemin relatif : commence par `/`, ni `//` ni `/\`,
 * sans antislash ni caractère de contrôle (les navigateurs les normalisent en `//`).
 */
export function isSafeNext(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    v.length <= 2048 &&
    v.startsWith('/') &&
    !v.startsWith('//') &&
    ![...v].some((c) => c === '\\' || c <= '\u001f' || c === '\u007f')
  )
}

const field = (req: Request, name: string): string => {
  const v = (req.body as Record<string, unknown> | undefined)?.[name]
  return typeof v === 'string' ? v : ''
}

const cookieOf = (req: Request, name: string): string | undefined => {
  const v = (req.cookies as Record<string, unknown> | undefined)?.[name]
  return typeof v === 'string' ? v : undefined
}

export function createAuthPagesRouter({ users, sessions, setupCode, env }: AuthPagesDeps): Router {
  const router = Router()
  const form = express.urlencoded({ extended: false, limit: '16kb' })

  const limiter = () =>
    rateLimit({
      windowMs: 60_000,
      limit: 10,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      handler: (req, res) => {
        log('warn', 'Trop de tentatives', { ip: req.ip, path: req.path })
        sendPage(
          res,
          429,
          'Trop de tentatives',
          '<p>Trop de tentatives depuis votre adresse. Patientez une minute avant de réessayer.</p>',
        )
      },
    })

  const startSession = (res: express.Response, userId: number) => {
    res.cookie(SESSION_COOKIE, sessions.create(userId), sessionCookieOptions(env))
  }

  // /setup n'existe plus dès qu'un compte existe.
  const setupOpen: RequestHandler = (_req, res, next) => {
    if (users.count() > 0) {
      sendPage(res, 404, 'Page introuvable', '<p>Cette page n’existe pas.</p>')
      return
    }
    next()
  }

  router.get('/setup', setupOpen, (req, res) => {
    sendPage(res, 200, 'Configuration initiale', setupBody({ csrf: issueCsrfToken(req, res, env) }))
  })

  router.post('/setup', setupOpen, limiter(), form, requireCsrf, async (req, res) => {
    const email = field(req, 'email').trim()
    const password = field(req, 'password')
    const fail = (status: number, error: string) =>
      sendPage(
        res,
        status,
        'Configuration initiale',
        setupBody({ csrf: issueCsrfToken(req, res, env), email, error }),
      )

    const expected = setupCode.value
    const given = normalizeSetupCode(field(req, 'code'))
    if (expected === null || given === '' || !safeEqual(given, normalizeSetupCode(expected))) {
      log('warn', 'Code de configuration refusé', { ip: req.ip })
      fail(403, 'Code de configuration invalide.')
      return
    }
    if (!isValidEmail(email)) {
      fail(400, 'Adresse email invalide.')
      return
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      fail(400, PASSWORD_TOO_SHORT)
      return
    }

    // Le code est consommé avant tout await : deux requêtes simultanées ne peuvent pas l'utiliser.
    setupCode.value = null
    let userId: number
    try {
      userId = (await users.create(email, password)).id
    } catch (err) {
      setupCode.value = expected
      throw err
    }
    log('info', 'Compte administrateur créé via /setup', { user_id: userId })
    startSession(res, userId)
    res.redirect(302, DEFAULT_NEXT)
  })

  router.get('/login', (req, res) => {
    const next = isSafeNext(req.query.next) ? req.query.next : ''
    if (sessions.resolve(cookieOf(req, SESSION_COOKIE))) {
      res.redirect(302, next || DEFAULT_NEXT)
      return
    }
    sendPage(res, 200, 'Connexion', loginBody({ csrf: issueCsrfToken(req, res, env), next }))
  })

  router.post('/login', limiter(), form, requireCsrf, async (req, res) => {
    const email = field(req, 'email').trim()
    const rawNext = field(req, 'next')
    const next = isSafeNext(rawNext) ? rawNext : ''
    const user = await users.verify(email, field(req, 'password'))
    if (!user) {
      log('warn', 'Connexion refusée', { ip: req.ip })
      sendPage(
        res,
        401,
        'Connexion',
        loginBody({ csrf: issueCsrfToken(req, res, env), email, next, error: LOGIN_FAILED }),
      )
      return
    }
    sessions.destroy(cookieOf(req, SESSION_COOKIE))
    startSession(res, user.id)
    log('info', 'Connexion administrateur', { user_id: user.id })
    res.redirect(302, next || DEFAULT_NEXT)
  })

  router.post('/logout', form, requireCsrf, (req, res) => {
    sessions.destroy(cookieOf(req, SESSION_COOKIE))
    res.clearCookie(SESSION_COOKIE, { ...baseCookieOptions(env), sameSite: 'lax' })
    res.redirect(302, '/login')
  })

  return router
}
