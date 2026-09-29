import { eq, lt } from 'drizzle-orm'
import { db } from '../../db/client.ts'
import { sessions, type User, users } from '../../db/schema.ts'

// Users and sessions are looked up before the contractor is known,
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
