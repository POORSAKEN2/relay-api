import { db } from '../../db/client.ts'
import { violatedUniqueConstraint } from '../../lib/db-errors.ts'
import { HttpError } from '../../lib/http-error.ts'
import { emitToTenant } from '../../realtime/index.ts'
import type { SessionUser } from '../accounts/accounts.service.ts'
import * as audit from '../audit/audit.queries.ts'
import { tenantOf } from '../booking/booking.service.ts'
import * as queries from './team.queries.ts'
import type { TechnicianInput } from './team.schemas.ts'

// Owner and office staff manage their contractor's technicians. Technicians are never
// deleted: deactivating keeps their name on past jobs.

const NOT_ON_TEAM = 'That technician isn’t on your team.'

type TechnicianRow = NonNullable<Awaited<ReturnType<typeof queries.findTechnician>>>

function toTechnician({ disabledAt, ...row }: TechnicianRow) {
  return { ...row, active: disabledAt === null }
}

export async function list(tenantId: string) {
  return (await queries.listTechnicians(tenantId)).map(toTechnician)
}

export async function add(user: SessionUser, input: TechnicianInput) {
  const tenantId = tenantOf(user)
  const { id } = await saveOrExplain(() =>
    queries.insertTechnician(tenantId, {
      ...input,
      email: input.email ?? null,
      photoUrl: input.photoUrl ?? null,
    }),
  )
  await audit.insertUserAction(tenantId, {
    actorUserId: user.id,
    action: 'user.created',
    entityType: 'user',
    entityId: id,
    data: { role: 'technician' },
  })
  emitToTenant(tenantId, 'team.updated', { tenantId })
  return found(await queries.findTechnician(tenantId, id))
}

export async function update(user: SessionUser, technicianId: string, input: TechnicianInput) {
  const tenantId = tenantOf(user)
  const updated = await saveOrExplain(() =>
    queries.updateTechnician(tenantId, technicianId, {
      ...input,
      email: input.email ?? null,
      photoUrl: input.photoUrl ?? null,
    }),
  )
  if (!updated) throw new HttpError(404, 'not_found', NOT_ON_TEAM)
  await audit.insertUserAction(tenantId, {
    actorUserId: user.id,
    action: 'user.updated',
    entityType: 'user',
    entityId: technicianId,
  })
  emitToTenant(tenantId, 'team.updated', { tenantId })
  return found(await queries.findTechnician(tenantId, technicianId))
}

// Takes the technician off the team: their open jobs from today on move to Unassigned for
// re-dispatch, and they are signed out. Doing it twice is harmless.
export async function deactivate(user: SessionUser, technicianId: string) {
  const tenantId = tenantOf(user)
  const moved = await db.transaction(async (tx) => {
    const technician = await queries.lockTechnician(tenantId, technicianId, tx)
    if (!technician) throw new HttpError(404, 'not_found', NOT_ON_TEAM)
    const jobs = await queries.unassignUpcomingJobs(tenantId, technicianId, tx)
    await queries.endSessions(technicianId, tx)
    if (!technician.disabledAt) {
      await queries.updateTechnician(tenantId, technicianId, { disabledAt: new Date() }, tx)
    }
    await audit.insertUserAction(
      tenantId,
      {
        actorUserId: user.id,
        action: 'user.deactivated',
        entityType: 'user',
        entityId: technicianId,
        data: { unassignedJobIds: jobs.map((job) => job.id) },
      },
      tx,
    )
    return jobs
  })

  const dates = [...new Set(moved.map((job) => job.date))].sort()
  emitToTenant(tenantId, 'team.updated', { tenantId })
  if (moved.length > 0) emitToTenant(tenantId, 'job.assigned', { jobId: moved[0].id, dates })
  return {
    technician: found(await queries.findTechnician(tenantId, technicianId)),
    unassignedJobs: moved.length,
    dates,
  }
}

export async function reactivate(user: SessionUser, technicianId: string) {
  const tenantId = tenantOf(user)
  const updated = await queries.updateTechnician(tenantId, technicianId, { disabledAt: null })
  if (!updated) throw new HttpError(404, 'not_found', NOT_ON_TEAM)
  await audit.insertUserAction(tenantId, {
    actorUserId: user.id,
    action: 'user.reactivated',
    entityType: 'user',
    entityId: technicianId,
  })
  emitToTenant(tenantId, 'team.updated', { tenantId })
  return found(await queries.findTechnician(tenantId, technicianId))
}

// Phone numbers and emails are unique across all of Relay; say which one is taken.
async function saveOrExplain<T>(save: () => Promise<T>): Promise<T> {
  try {
    return await save()
  } catch (error) {
    const constraint = violatedUniqueConstraint(error)
    if (constraint === 'users_phone_unique') {
      throw new HttpError(
        409,
        'phone_taken',
        'That phone number is already used by another account.',
      )
    }
    if (constraint === 'users_email_unique') {
      throw new HttpError(409, 'email_taken', 'That email is already used by another account.')
    }
    throw error
  }
}

function found(row: TechnicianRow | undefined) {
  if (!row) throw new HttpError(404, 'not_found', NOT_ON_TEAM)
  return toTechnician(row)
}
