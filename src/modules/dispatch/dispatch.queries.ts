import { and, asc, desc, eq, isNull, notInArray, type SQL, sql } from 'drizzle-orm'
import { alias, type PgColumn } from 'drizzle-orm/pg-core'
import { type Db, db, type Tx } from '../../db/client.ts'
import {
  arrivalWindows,
  bookingDrafts,
  bookingPhotos,
  customers,
  jobNotes,
  jobPhotos,
  jobs,
  properties,
  services,
  tenants,
  users,
} from '../../db/schema.ts'
import { INACTIVE_STATUSES } from '../booking/booking.queries.ts'

// Tenant-scoped: every query takes tenantId first. Local times are the contractor's wall
// clock, worked out in Postgres from tenants.timezone.

const technicians = alias(users, 'technicians')
const authors = alias(users, 'authors')

// A timestamp as the contractor's wall clock, e.g. 'YYYY-MM-DD' or 'HH24:MI:SS'. Needs
// `tenants` joined. Also used by the technician job list.
export function local(column: PgColumn, format: string): SQL<string> {
  return sql<string>`to_char(${column} at time zone ${tenants.timezone}, ${format})`
}

// Like local(), for a column that may be empty: null stays null.
export function localOrNull(column: PgColumn, format: string): SQL<string | null> {
  return sql<string | null>`to_char(${column} at time zone ${tenants.timezone}, ${format})`
}

// The arrival window a job sits in: same weekday and same local start time. A job whose
// window was changed or removed since booking matches none.
export const matchingWindow = and(
  eq(arrivalWindows.tenantId, jobs.tenantId),
  sql`${arrivalWindows.weekday} = extract(dow from ${jobs.windowStartsAt} at time zone ${tenants.timezone})`,
  sql`${arrivalWindows.startsAt} = (${jobs.windowStartsAt} at time zone ${tenants.timezone})::time`,
)

export async function findTimezone(tenantId: string) {
  const [tenant] = await db
    .select({ timezone: tenants.timezone })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
  return tenant.timezone
}

export function listWindowsOn(tenantId: string, weekday: number) {
  return db
    .select({
      id: arrivalWindows.id,
      startsAt: arrivalWindows.startsAt,
      endsAt: arrivalWindows.endsAt,
      jobCap: arrivalWindows.jobCap,
    })
    .from(arrivalWindows)
    .where(and(eq(arrivalWindows.tenantId, tenantId), eq(arrivalWindows.weekday, weekday)))
    .orderBy(asc(arrivalWindows.startsAt))
}

export function listActiveTechnicians(tenantId: string) {
  return db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(
      and(eq(users.tenantId, tenantId), eq(users.role, 'technician'), isNull(users.disabledAt)),
    )
    .orderBy(asc(users.name))
}

export async function findActiveTechnician(tenantId: string, userId: string, tx: Db = db) {
  const [technician] = await tx
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.tenantId, tenantId),
        eq(users.id, userId),
        eq(users.role, 'technician'),
        isNull(users.disabledAt),
      ),
    )
  return technician
}

// Jobs holding a place on local day `date`, PRIORITY first.
export function listJobsOn(tenantId: string, date: string) {
  return db
    .select({
      id: jobs.id,
      status: jobs.status,
      priority: jobs.priority,
      source: jobs.source,
      technicianId: jobs.technicianId,
      windowId: arrivalWindows.id,
      localStart: local(jobs.windowStartsAt, 'HH24:MI:SS'),
      localEnd: local(jobs.windowEndsAt, 'HH24:MI:SS'),
      etaLocal: localOrNull(jobs.etaAt, 'HH24:MI:SS'), // set by "On my way" / "Running late"
      customerName: customers.name,
      city: properties.city,
      serviceName: services.name,
      problem: jobs.problem,
    })
    .from(jobs)
    .innerJoin(tenants, eq(tenants.id, jobs.tenantId))
    .innerJoin(customers, eq(customers.id, jobs.customerId))
    .innerJoin(properties, eq(properties.id, jobs.propertyId))
    .innerJoin(services, eq(services.id, jobs.serviceId))
    .leftJoin(arrivalWindows, matchingWindow)
    .where(
      and(
        eq(jobs.tenantId, tenantId),
        notInArray(jobs.status, [...INACTIVE_STATUSES]),
        sql`${jobs.windowStartsAt} >= ${date}::date::timestamp at time zone ${tenants.timezone}`,
        sql`${jobs.windowStartsAt} < (${date}::date + 1)::timestamp at time zone ${tenants.timezone}`,
      ),
    )
    .orderBy(desc(jobs.priority), asc(jobs.windowStartsAt), asc(jobs.createdAt))
}

export async function findJobDetail(tenantId: string, jobId: string) {
  const [job] = await db
    .select({
      id: jobs.id,
      status: jobs.status,
      priority: jobs.priority,
      source: jobs.source,
      bookedVia: jobs.bookedVia,
      problem: jobs.problem,
      systemType: jobs.systemType,
      vulnerableOccupant: jobs.vulnerableOccupant,
      date: local(jobs.windowStartsAt, 'YYYY-MM-DD'),
      localStart: local(jobs.windowStartsAt, 'HH24:MI:SS'),
      localEnd: local(jobs.windowEndsAt, 'HH24:MI:SS'),
      etaLocal: localOrNull(jobs.etaAt, 'HH24:MI:SS'),
      completedLocal: localOrNull(jobs.completedAt, 'HH24:MI:SS'),
      windowId: arrivalWindows.id,
      technicianId: technicians.id,
      technicianName: technicians.name,
      service: { id: services.id, name: services.name },
      customer: {
        id: customers.id,
        name: customers.name,
        phone: customers.phone,
        email: customers.email,
      },
      property: {
        street: properties.street,
        unit: properties.unit,
        city: properties.city,
        state: properties.state,
        zip: properties.zip,
        equipmentBrand: properties.equipmentBrand,
        equipmentYear: properties.equipmentYear,
        notes: properties.notes,
      },
      bookedAt: jobs.bookedAt,
      completedAt: jobs.completedAt,
      createdAt: jobs.createdAt,
    })
    .from(jobs)
    .innerJoin(tenants, eq(tenants.id, jobs.tenantId))
    .innerJoin(customers, eq(customers.id, jobs.customerId))
    .innerJoin(properties, eq(properties.id, jobs.propertyId))
    .innerJoin(services, eq(services.id, jobs.serviceId))
    .leftJoin(technicians, eq(technicians.id, jobs.technicianId))
    .leftJoin(arrivalWindows, matchingWindow)
    .where(and(eq(jobs.tenantId, tenantId), eq(jobs.id, jobId)))
  return job
}

export function listNotes(tenantId: string, jobId: string) {
  return db
    .select({
      id: jobNotes.id,
      body: jobNotes.body,
      authorName: authors.name,
      createdAt: jobNotes.createdAt,
    })
    .from(jobNotes)
    .leftJoin(authors, eq(authors.id, jobNotes.authorId))
    .where(and(eq(jobNotes.tenantId, tenantId), eq(jobNotes.jobId, jobId)))
    .orderBy(asc(jobNotes.createdAt))
}

// Locks the job until the transaction ends, so two people can't change it at once.
export async function lockJob(tenantId: string, jobId: string, tx: Tx) {
  const [job] = await tx
    .select({
      id: jobs.id,
      status: jobs.status,
      technicianId: jobs.technicianId,
      windowStartsAt: jobs.windowStartsAt,
      date: local(jobs.windowStartsAt, 'YYYY-MM-DD'),
      windowId: arrivalWindows.id,
    })
    .from(jobs)
    .innerJoin(tenants, eq(tenants.id, jobs.tenantId))
    .leftJoin(arrivalWindows, matchingWindow)
    .where(and(eq(jobs.tenantId, tenantId), eq(jobs.id, jobId)))
    .for('update', { of: jobs })
  return job
}

// What the technician's "job assigned" / "job changed" text says: who, which job, when, and
// the contractor's address for the link.
export async function findAssignmentText(
  tenantId: string,
  jobId: string,
  technicianId: string,
  tx: Db,
) {
  const [row] = await tx
    .select({
      tenant: {
        slug: tenants.slug,
        customDomain: tenants.customDomain,
        customDomainVerifiedAt: tenants.customDomainVerifiedAt,
      },
      contractorName: tenants.name,
      technicianPhone: users.phone,
      serviceName: services.name,
      city: properties.city,
      date: local(jobs.windowStartsAt, 'YYYY-MM-DD'),
      localStart: local(jobs.windowStartsAt, 'HH24:MI:SS'),
      localEnd: local(jobs.windowEndsAt, 'HH24:MI:SS'),
    })
    .from(jobs)
    .innerJoin(tenants, eq(tenants.id, jobs.tenantId))
    .innerJoin(properties, eq(properties.id, jobs.propertyId))
    .innerJoin(services, eq(services.id, jobs.serviceId))
    .innerJoin(users, and(eq(users.tenantId, jobs.tenantId), eq(users.id, technicianId)))
    .where(and(eq(jobs.tenantId, tenantId), eq(jobs.id, jobId)))
  return row
}

export async function jobExists(tenantId: string, jobId: string) {
  const [job] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.tenantId, tenantId), eq(jobs.id, jobId)))
  return Boolean(job)
}

export async function updateJob(
  tenantId: string,
  jobId: string,
  values: Partial<Omit<typeof jobs.$inferInsert, 'id' | 'tenantId'>>,
  tx: Db = db,
) {
  await tx
    .update(jobs)
    .set(values)
    .where(and(eq(jobs.tenantId, tenantId), eq(jobs.id, jobId)))
}

export async function insertNote(
  tenantId: string,
  values: { jobId: string; authorId: string | null; body: string }, // author null = AI call summary
  tx: Db = db,
) {
  const [note] = await tx
    .insert(jobNotes)
    .values({ ...values, tenantId })
    .returning({ id: jobNotes.id, body: jobNotes.body, createdAt: jobNotes.createdAt })
  return note
}

// A booking photo and the draft it was added to.
const photoDraft = and(
  eq(bookingDrafts.tenantId, bookingPhotos.tenantId),
  eq(bookingDrafts.id, bookingPhotos.draftId),
)

// Photos the homeowner added while booking this job online (step 4), oldest first.
export function listJobPhotos(tenantId: string, jobId: string) {
  return db
    .select({ id: bookingPhotos.id })
    .from(bookingPhotos)
    .innerJoin(bookingDrafts, photoDraft)
    .where(and(eq(bookingPhotos.tenantId, tenantId), eq(bookingDrafts.bookedJobId, jobId)))
    .orderBy(asc(bookingPhotos.createdAt))
}

export async function findJobPhoto(tenantId: string, jobId: string, photoId: string) {
  const [photo] = await db
    .select({ contentType: bookingPhotos.contentType, data: bookingPhotos.data })
    .from(bookingPhotos)
    .innerJoin(bookingDrafts, photoDraft)
    .where(
      and(
        eq(bookingPhotos.tenantId, tenantId),
        eq(bookingDrafts.bookedJobId, jobId),
        eq(bookingPhotos.id, photoId),
      ),
    )
  return photo
}

// The technician's own photos of a job, oldest first, with the stage each belongs to. Shown to
// the office and to the technician.
export function listWorkPhotos(tenantId: string, jobId: string, tx: Db = db) {
  return tx
    .select({ id: jobPhotos.id, stage: jobPhotos.stage })
    .from(jobPhotos)
    .where(and(eq(jobPhotos.tenantId, tenantId), eq(jobPhotos.jobId, jobId)))
    .orderBy(asc(jobPhotos.createdAt))
}

export async function insertWorkPhoto(
  tenantId: string,
  values: Pick<
    typeof jobPhotos.$inferInsert,
    'jobId' | 'stage' | 'contentType' | 'data' | 'uploadedBy'
  >,
  tx: Db = db,
) {
  const [photo] = await tx
    .insert(jobPhotos)
    .values({ tenantId, ...values })
    .returning({ id: jobPhotos.id })
  return photo
}

export async function findWorkPhoto(tenantId: string, jobId: string, photoId: string) {
  const [photo] = await db
    .select({ contentType: jobPhotos.contentType, data: jobPhotos.data })
    .from(jobPhotos)
    .where(
      and(eq(jobPhotos.tenantId, tenantId), eq(jobPhotos.jobId, jobId), eq(jobPhotos.id, photoId)),
    )
  return photo
}

export function deleteWorkPhoto(tenantId: string, jobId: string, photoId: string, tx: Db = db) {
  return tx
    .delete(jobPhotos)
    .where(
      and(eq(jobPhotos.tenantId, tenantId), eq(jobPhotos.jobId, jobId), eq(jobPhotos.id, photoId)),
    )
}
