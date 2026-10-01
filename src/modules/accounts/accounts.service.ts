import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto'
import { env } from '../../config/env.ts'
import type { User, UserRole } from '../../db/schema.ts'
import { HttpError } from '../../lib/http-error.ts'
import { sendText } from '../messaging/sms.ts'
import * as queries from './accounts.queries.ts'
import { hashPassword, verifyPassword } from './passwords.ts'

const MINUTE_MS = 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const SESSION_DAYS = 30
const RENEW_WHEN_DAYS_LEFT = 15
const CODE_MINUTES = 10
const CODES_PER_HOUR = 5
const CODE_TRIES = 5

export type SessionUser = {
  id: string
  name: string
  email: string | null // technicians sign in by SMS and may have none
  role: UserRole
  tenantId: string | null
}

export async function signIn(email: string, password: string) {
  const user = await queries.findUserByEmail(email)
  // Check a password even for an unknown email, so both failures take the same time.
  const passwordOk = await verifyPassword(password, user?.passwordHash ?? (await dummyHash()))
  if (!user?.passwordHash || !passwordOk) {
    throw new HttpError(401, 'unauthorized', 'Wrong email or password')
  }
  return startSession(user)
}

async function startSession(user: User) {
  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + SESSION_DAYS * DAY_MS)
  await queries.insertSession({ id: hashToken(token), userId: user.id, expiresAt })
  return { token, expiresAt, user: toSessionUser(user) }
}

// Texts a 6-digit sign-in code to an active technician. An unknown number gets the same
// (empty) answer, so nobody can use this to find out which numbers are technicians'.
export async function requestSignInCode(phone: string) {
  const found = await queries.findTechnicianByPhone(phone)
  if (!found) return

  // At most 5 codes an hour per phone: each text costs money and could pester someone.
  // Codes over an hour old are deleted here, so the table needs no cleanup job.
  await queries.deleteCodesBefore(found.user.id, new Date(Date.now() - 60 * MINUTE_MS))
  if ((await queries.countCodes(found.user.id)) >= CODES_PER_HOUR) return

  const code = randomInt(0, 1_000_000).toString().padStart(6, '0')
  await queries.insertCode({
    userId: found.user.id,
    codeHash: hashCode(code),
    expiresAt: new Date(Date.now() + CODE_MINUTES * MINUTE_MS),
  })
  await sendText(found.tenantId, {
    contact: phone,
    kind: 'sign_in_code',
    body: `${found.tenantName}: your sign-in code is ${code}. It expires in ${CODE_MINUTES} minutes.`,
    toUserId: found.user.id,
  })
}

// Codes are stored as an HMAC keyed with a server secret, so a copy of the database alone
// isn't enough to work out a live code.
export function hashCode(code: string): string {
  return createHmac('sha256', env.SIGN_IN_CODE_SECRET).update(code).digest('hex')
}

// Signs a technician in with the code texted to them. Every guess uses up one of the code's
// 5 tries. An unknown number, a wrong code and a used or expired one all get the same answer.
export async function signInWithCode(phone: string, typedCode: string) {
  const found = await queries.findTechnicianByPhone(phone)
  if (!found) throw wrongCode()
  const code = await queries.findNewestCode(found.user.id)
  if (!code) throw wrongCode()

  const now = new Date()
  if (!(await queries.spendCodeTry(code.id, CODE_TRIES, now))) throw wrongCode()
  if (!sameHash(hashCode(typedCode), code.codeHash)) throw wrongCode()
  if (!(await queries.markCodeUsed(code.id, now))) throw wrongCode()
  return startSession(found.user)
}

function wrongCode() {
  return new HttpError(401, 'unauthorized', 'That code is wrong or has expired. Ask for a new one.')
}

// Compares two hex hashes in constant time, so response timing gives nothing away.
function sameHash(a: string, b: string): boolean {
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
}

// The session's user, or null if the token is unknown or expired.
// With `renew`, a session with under 15 days left is extended to 30 days;
// `renewed` tells the caller to send the cookie again.
export async function validateSession(token: string, { renew }: { renew: boolean }) {
  const found = await queries.findSessionWithUser(hashToken(token))
  if (!found || found.session.expiresAt <= new Date()) return null

  const daysLeft = (found.session.expiresAt.getTime() - Date.now()) / DAY_MS
  const renewed = renew && daysLeft < RENEW_WHEN_DAYS_LEFT
  const expiresAt = renewed ? new Date(Date.now() + SESSION_DAYS * DAY_MS) : found.session.expiresAt
  if (renewed) await queries.updateSessionExpiry(found.session.id, expiresAt)

  return { user: toSessionUser(found.user), expiresAt, renewed }
}

export async function signOut(token: string) {
  await queries.deleteSession(hashToken(token))
}

export function cleanupExpiredSessions(): Promise<number> {
  return queries.deleteExpiredSessions(new Date())
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function toSessionUser(user: User): SessionUser {
  const { id, name, email, role, tenantId } = user
  return { id, name, email, role, tenantId }
}

let dummy: Promise<string> | undefined
function dummyHash(): Promise<string> {
  dummy ??= hashPassword(randomUUID())
  return dummy
}
