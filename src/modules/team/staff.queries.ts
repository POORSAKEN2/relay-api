import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { type Db, db, type Tx } from '../../db/client.ts'
import { sessions, signInLinks, tenants, users } from '../../db/schema.ts'

// Tenant-scoped: every query takes tenantId first. Only owner and office accounts are
// touched here; technicians live in team.queries.ts.

const isStaffOf = (tenantId: string) =>
  and(eq(users.tenantId, tenantId), inArray(users.role, ['owner', 'office']))

// `invited`: they have no password and have not used a link yet, so they never signed in.
function selectStaff(tx: Db) {
  return tx
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      disabledAt: users.disabledAt,
      invited: sql<boolean>`(${users.passwordHash} is null and not exists (${tx
        .select({ one: sql`1` })
        .from(signInLinks)
        .where(and(eq(signInLinks.userId, users.id), sql`${signInLinks.usedAt} is not null`))}))`,
    })
    .from(users)
}

// Active staff first, then by name.
export function listStaff(tenantId: string) {
  return selectStaff(db)
    .where(isStaffOf(tenantId))
    .orderBy(sql`${users.disabledAt} is not null`, asc(users.name))
}

export async function findStaff(tenantId: string, staffId: string, tx: Db = db) {
  const [person] = await selectStaff(tx).where(and(isStaffOf(tenantId), eq(users.id, staffId)))
  return person
}

type StaffValues = { name: string; email: string; role: 'owner' | 'office' }

export async function insertStaff(tenantId: string, values: StaffValues) {
  const [person] = await db
    .insert(users)
    .values({ ...values, tenantId })
    .returning({ id: users.id })
  return person
}

// Returns the id when the person was found (and updated), undefined otherwise.
export async function updateStaff(
  tenantId: string,
  staffId: string,
  values: Partial<StaffValues & Pick<typeof users.$inferInsert, 'disabledAt'>>,
  tx: Db = db,
) {
  const [person] = await tx
    .update(users)
    .set(values)
    .where(and(isStaffOf(tenantId), eq(users.id, staffId)))
    .returning({ id: users.id })
  return person
}

// Locks the person's row until the transaction ends.
export async function lockStaff(tenantId: string, staffId: string, tx: Tx) {
  const [person] = await tx
    .select({ id: users.id, role: users.role, disabledAt: users.disabledAt })
    .from(users)
    .where(and(isStaffOf(tenantId), eq(users.id, staffId)))
    .for('update')
  return person
}

// What the sign-in link email needs to name and address the contractor.
export async function findTenant(tenantId: string) {
  const [tenant] = await db
    .select({
      name: tenants.name,
      slug: tenants.slug,
      customDomain: tenants.customDomain,
      customDomainVerifiedAt: tenants.customDomainVerifiedAt,
    })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
  return tenant
}

// Voids the person's unused sign-in links, for when their email changes.
export async function endLinks(userId: string) {
  await db
    .delete(signInLinks)
    .where(and(eq(signInLinks.userId, userId), isNull(signInLinks.usedAt)))
}

// Signs the person out everywhere and voids any unused link. Used links stay: they show the
// person has signed in before.
export async function endAccess(userId: string, tx: Tx) {
  await tx.delete(sessions).where(eq(sessions.userId, userId))
  await tx
    .delete(signInLinks)
    .where(and(eq(signInLinks.userId, userId), isNull(signInLinks.usedAt)))
}
