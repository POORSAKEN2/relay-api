import { and, asc, eq, sql } from 'drizzle-orm'
import { type Db, db } from '../../db/client.ts'
import { jobItems, jobs, services } from '../../db/schema.ts'

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
