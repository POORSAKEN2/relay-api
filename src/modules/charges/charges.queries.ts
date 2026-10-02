import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { type Db, db, type Tx } from '../../db/client.ts'
import { jobItems, jobs, priceItems, services, tenants } from '../../db/schema.ts'

// Tenant-scoped: every query takes tenantId first. This module owns job_items and reads the
// few other columns it needs itself, so it depends on no other module.

export const PRIORITY_LINE = 'Priority service'

// What a job's booked lines are made from: its service and the priority fee it was booked with.
export async function findBookedLineSource(tenantId: string, jobId: string, tx: Db) {
  const [source] = await tx
    .select({
      serviceName: services.name,
      priceType: services.priceType,
      priceCents: services.priceCents,
      priorityFeeCents: jobs.priorityFeeCents,
    })
    .from(jobs)
    .innerJoin(services, and(eq(services.tenantId, jobs.tenantId), eq(services.id, jobs.serviceId)))
    .where(and(eq(jobs.tenantId, tenantId), eq(jobs.id, jobId)))
  return source
}

type LineValues = Omit<typeof jobItems.$inferInsert, 'id' | 'tenantId' | 'createdAt'>

export function insertLines(tenantId: string, lines: LineValues[], tx: Db) {
  return tx
    .insert(jobItems)
    .values(lines.map((line) => ({ ...line, tenantId })))
    .returning({ id: jobItems.id })
}

// A job's lines: the service line, then priority service, then repairs as they were added.
// Booked lines are written together, so their order is spelled out rather than taken from time.
export function listLines(tenantId: string, jobId: string, tx: Db = db) {
  return tx
    .select({
      id: jobItems.id,
      description: jobItems.description,
      quantity: jobItems.quantity,
      unitPriceCents: jobItems.unitPriceCents,
      status: jobItems.status,
    })
    .from(jobItems)
    .where(and(eq(jobItems.tenantId, tenantId), eq(jobItems.jobId, jobId)))
    .orderBy(
      sql`${jobItems.priceItemId} is not null`,
      sql`${jobItems.description} = ${PRIORITY_LINE}`,
      asc(jobItems.createdAt),
      asc(jobItems.id),
    )
}

// The job's status, technician and local day, locked until the transaction ends, so a status
// change can't slip in between the check and the change.
export async function lockJob(tenantId: string, jobId: string, tx: Tx) {
  const [job] = await tx
    .select({
      status: jobs.status,
      technicianId: jobs.technicianId,
      date: sql<string>`to_char(${jobs.windowStartsAt} at time zone ${tenants.timezone}, 'YYYY-MM-DD')`,
    })
    .from(jobs)
    .innerJoin(tenants, eq(tenants.id, jobs.tenantId))
    .where(and(eq(jobs.tenantId, tenantId), eq(jobs.id, jobId)))
    .for('update', { of: jobs })
  return job
}

export async function findActivePriceItem(tenantId: string, priceItemId: string, tx: Db) {
  const [item] = await tx
    .select({ name: priceItems.name, priceCents: priceItems.priceCents })
    .from(priceItems)
    .where(
      and(
        eq(priceItems.tenantId, tenantId),
        eq(priceItems.id, priceItemId),
        isNull(priceItems.archivedAt),
      ),
    )
  return item
}

export async function findLine(tenantId: string, jobId: string, itemId: string, tx: Db) {
  const [line] = await tx
    .select({ status: jobItems.status })
    .from(jobItems)
    .where(and(eq(jobItems.tenantId, tenantId), eq(jobItems.jobId, jobId), eq(jobItems.id, itemId)))
  return line
}

export async function deleteLine(tenantId: string, itemId: string, tx: Db) {
  await tx.delete(jobItems).where(and(eq(jobItems.tenantId, tenantId), eq(jobItems.id, itemId)))
}

// Marks every line waiting for the homeowner approved or declined. Returns the decided lines.
export function decideProposed(
  tenantId: string,
  jobId: string,
  status: 'approved' | 'declined',
  tx: Db,
) {
  return tx
    .update(jobItems)
    .set({ status })
    .where(
      and(
        eq(jobItems.tenantId, tenantId),
        eq(jobItems.jobId, jobId),
        eq(jobItems.status, 'proposed'),
      ),
    )
    .returning({
      id: jobItems.id,
      quantity: jobItems.quantity,
      unitPriceCents: jobItems.unitPriceCents,
    })
}
