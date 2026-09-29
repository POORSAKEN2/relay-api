import { and, asc, eq, gte, inArray, sql } from 'drizzle-orm'
import { type Db, db, type Tx } from '../../db/client.ts'
import { jobs, sessions, signInCodes, tenants, users } from '../../db/schema.ts'

// Tenant-scoped: every query takes tenantId first. Only technician accounts are touched here.

// Jobs that still need a technician's visit: not started, not closed.
const OPEN_STATUSES = ['booked', 'no_access', 'held'] as const

// Midnight today in the contractor's time zone. Needs `tenants` in the query.
const startOfLocalToday = sql`(now() at time zone ${tenants.timezone})::date::timestamp at time zone ${tenants.timezone}`

function selectTechnicians(tx: Db) {
  return tx
    .select({
      id: users.id,
      name: users.name,
      phone: users.phone,
      email: users.email,
      disabledAt: users.disabledAt,
      upcomingJobs: sql<number>`(${tx
        .select({ count: sql`count(*)::int` })
        .from(jobs)
        .where(
          and(
            eq(jobs.technicianId, users.id),
            inArray(jobs.status, [...OPEN_STATUSES]),
            gte(jobs.windowStartsAt, startOfLocalToday),
          ),
        )})`,
    })
    .from(users)
    .innerJoin(tenants, eq(tenants.id, users.tenantId))
}

const isTechnicianOf = (tenantId: string) =>
  and(eq(users.tenantId, tenantId), eq(users.role, 'technician'))

// Active technicians first, then by name.
export function listTechnicians(tenantId: string) {
  return selectTechnicians(db)
    .where(isTechnicianOf(tenantId))
    .orderBy(sql`${users.disabledAt} is not null`, asc(users.name))
}

export async function findTechnician(tenantId: string, technicianId: string, tx: Db = db) {
  const [technician] = await selectTechnicians(tx).where(
    and(isTechnicianOf(tenantId), eq(users.id, technicianId)),
  )
  return technician
}

export async function insertTechnician(
  tenantId: string,
  values: { name: string; phone: string; email: string | null },
) {
  const [technician] = await db
    .insert(users)
    .values({ ...values, tenantId, role: 'technician' })
    .returning({ id: users.id })
  return technician
}

// Returns the id when the technician was found (and updated), undefined otherwise.
export async function updateTechnician(
  tenantId: string,
  technicianId: string,
  values: Partial<Pick<typeof users.$inferInsert, 'name' | 'phone' | 'email' | 'disabledAt'>>,
  tx: Db = db,
) {
  const [technician] = await tx
    .update(users)
    .set(values)
    .where(and(isTechnicianOf(tenantId), eq(users.id, technicianId)))
    .returning({ id: users.id })
  return technician
}

// Locks the technician's row until the transaction ends.
export async function lockTechnician(tenantId: string, technicianId: string, tx: Tx) {
  const [technician] = await tx
    .select({ id: users.id, disabledAt: users.disabledAt })
    .from(users)
    .where(and(isTechnicianOf(tenantId), eq(users.id, technicianId)))
    .for('update')
  return technician
}

// Takes the technician off their open jobs from today on (jobs under way are left alone).
// Returns each job with its local day, for refreshing the right boards.
export async function unassignUpcomingJobs(tenantId: string, technicianId: string, tx: Tx) {
  const upcoming = await tx
    .select({
      id: jobs.id,
      date: sql<string>`to_char(${jobs.windowStartsAt} at time zone ${tenants.timezone}, 'YYYY-MM-DD')`,
    })
    .from(jobs)
    .innerJoin(tenants, eq(tenants.id, jobs.tenantId))
    .where(
      and(
        eq(jobs.tenantId, tenantId),
        eq(jobs.technicianId, technicianId),
        inArray(jobs.status, [...OPEN_STATUSES]),
        gte(jobs.windowStartsAt, startOfLocalToday),
      ),
    )
    .for('update', { of: jobs })
  if (upcoming.length > 0) {
    await tx
      .update(jobs)
      .set({ technicianId: null })
      .where(
        and(
          eq(jobs.tenantId, tenantId),
          inArray(
            jobs.id,
            upcoming.map((job) => job.id),
          ),
        ),
      )
  }
  return upcoming
}

// Signs the user out everywhere and voids any sign-in codes they were sent.
export async function endSessions(userId: string, tx: Tx) {
  await tx.delete(sessions).where(eq(sessions.userId, userId))
  await tx.delete(signInCodes).where(eq(signInCodes.userId, userId))
}
