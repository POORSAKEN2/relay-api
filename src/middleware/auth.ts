import * as Sentry from '@sentry/node'
import { parseCookie } from 'cookie'
import type { Request, RequestHandler, Response } from 'express'
import { env } from '../config/env.ts'
import type { UserRole } from '../db/schema.ts'
import { HttpError } from '../lib/http-error.ts'
import { type SessionUser, validateSession } from '../modules/accounts/accounts.service.ts'

export const SESSION_COOKIE = 'relay_session'

const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: env.NODE_ENV === 'production',
  path: '/',
} as const

export function readSessionToken(cookieHeader: string | undefined): string | undefined {
  return cookieHeader ? parseCookie(cookieHeader)[SESSION_COOKIE] : undefined
}

export function setSessionCookie(res: Response, token: string, expiresAt: Date) {
  res.cookie(SESSION_COOKIE, token, { ...cookieOptions, expires: expiresAt })
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(SESSION_COOKIE, cookieOptions)
}

// The signed-in user, or null. Sends the cookie again when the session was extended.
export async function getSessionUser(req: Request, res: Response): Promise<SessionUser | null> {
  const token = readSessionToken(req.headers.cookie)
  if (!token) return null
  const session = await validateSession(token, { renew: true })
  if (!session) return null
  if (session.renewed) setSessionCookie(res, token, session.expiresAt)
  return session.user
}

// 401 when signed out, 403 when the role is not listed. Superadmin is not a wildcard.
export function requireRole(...roles: UserRole[]): RequestHandler {
  return async (req, res, next) => {
    const user = await getSessionUser(req, res)
    if (!user) throw new HttpError(401, 'unauthorized', 'Sign in required')
    Sentry.setUser({ id: user.id })
    Sentry.setTag('tenant', user.tenantId ?? 'relay')
    if (!roles.includes(user.role)) {
      throw new HttpError(403, 'forbidden', 'You do not have access to this')
    }
    req.user = user
    next()
  }
}
