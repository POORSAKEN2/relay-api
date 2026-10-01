import { and, count, eq, isNull, lt } from 'drizzle-orm'
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
    .where(eq(sessions.id, id))
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
