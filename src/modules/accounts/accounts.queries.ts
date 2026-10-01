import { and, count, desc, eq, gt, isNull, lt, sql } from 'drizzle-orm'
import { db } from '../../db/client.ts'
import { sessions, signInCodes, tenants, type User, users } from '../../db/schema.ts'

// Users, sessions and sign-in codes are looked up before the contractor is known,
// so these queries are not tenant-scoped.

export async function findUserByEmail(email: string): Promise<User | undefined> {
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1)
  return user
}

export async function insertSession(values: { id: string; userId: string; expiresAt: Date }) {
  await db.insert(sessions).values(values)
}

export async function findSessionWithUser(id: string) {
  const [row] = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    // Deactivation deletes sessions, but a sign-in racing it could insert one afterwards.
    // Checking here makes deactivation hold whatever the order.
    .where(and(eq(sessions.id, id), isNull(users.disabledAt)))
    .limit(1)
  return row
}

export async function updateSessionExpiry(id: string, expiresAt: Date) {
  await db.update(sessions).set({ expiresAt }).where(eq(sessions.id, id))
}

export async function deleteSession(id: string) {
  await db.delete(sessions).where(eq(sessions.id, id))
}

export async function deleteExpiredSessions(now: Date): Promise<number> {
  const deleted = await db
    .delete(sessions)
    .where(lt(sessions.expiresAt, now))
    .returning({ id: sessions.id })
  return deleted.length
}

// An active technician with this phone, and their contractor for the sign-in text.
export async function findTechnicianByPhone(phone: string) {
  const [row] = await db
    .select({ user: users, tenantId: tenants.id, tenantName: tenants.name })
    .from(users)
    .innerJoin(tenants, eq(users.tenantId, tenants.id))
    .where(and(eq(users.phone, phone), eq(users.role, 'technician'), isNull(users.disabledAt)))
    .limit(1)
  return row
}

export async function deleteCodesBefore(userId: string, before: Date) {
  await db
    .delete(signInCodes)
    .where(and(eq(signInCodes.userId, userId), lt(signInCodes.createdAt, before)))
}

export async function countCodes(userId: string): Promise<number> {
  const [row] = await db
    .select({ count: count() })
    .from(signInCodes)
    .where(eq(signInCodes.userId, userId))
  return row.count
}

export async function insertCode(values: { userId: string; codeHash: string; expiresAt: Date }) {
  await db.insert(signInCodes).values(values)
}

// The technician's newest code. Only the last one texted can be used.
export async function findNewestCode(userId: string) {
  const [code] = await db
    .select()
    .from(signInCodes)
    .where(eq(signInCodes.userId, userId))
    .orderBy(desc(signInCodes.createdAt))
    .limit(1)
  return code
}

// Uses up one try on a code that is unused, unexpired and has tries left; false if it has
// none. One UPDATE, so guesses sent at the same moment can't share a try.
export async function spendCodeTry(id: string, maxTries: number, now: Date): Promise<boolean> {
  const spent = await db
    .update(signInCodes)
    .set({ attempts: sql`${signInCodes.attempts} + 1` })
    .where(
      and(
        eq(signInCodes.id, id),
        isNull(signInCodes.usedAt),
        gt(signInCodes.expiresAt, now),
        lt(signInCodes.attempts, maxTries),
      ),
    )
    .returning({ id: signInCodes.id })
  return spent.length > 0
}

// Marks the code used; false if another request used it first.
export async function markCodeUsed(id: string, now: Date): Promise<boolean> {
  const used = await db
    .update(signInCodes)
    .set({ usedAt: now })
    .where(and(eq(signInCodes.id, id), isNull(signInCodes.usedAt)))
    .returning({ id: signInCodes.id })
  return used.length > 0
}
