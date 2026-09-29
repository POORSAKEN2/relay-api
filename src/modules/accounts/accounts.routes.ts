import { Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import { HttpError } from '../../lib/http-error.ts'
import {
  clearSessionCookie,
  getSessionUser,
  readSessionToken,
  setSessionCookie,
} from '../../middleware/auth.ts'
import { SignInInput } from './accounts.schemas.ts'
import * as accounts from './accounts.service.ts'

export const accountsRoutes = Router()

const signInLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (_req, _res, next) =>
    next(new HttpError(429, 'rate_limited', 'Too many sign-in attempts. Try again in 15 minutes.')),
})

accountsRoutes.post('/auth/sign-in', signInLimit, async (req, res) => {
  const { email, password } = SignInInput.parse(req.body)
  const session = await accounts.signIn(email, password)
  setSessionCookie(res, session.token, session.expiresAt)
  res.json({ user: session.user })
})

accountsRoutes.post('/auth/sign-out', async (req, res) => {
  const token = readSessionToken(req.headers.cookie)
  if (token) await accounts.signOut(token)
  clearSessionCookie(res)
  res.status(204).end()
})

accountsRoutes.get('/auth/me', async (req, res) => {
  res.json({ user: await getSessionUser(req, res) })
})
