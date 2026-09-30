import { db } from '../../db/client.ts'
import { HttpError } from '../../lib/http-error.ts'
import { emitToTenant } from '../../realtime/index.ts'
import type { SessionUser } from '../accounts/accounts.service.ts'
import * as audit from '../audit/audit.queries.ts'
import { tenantOf } from '../booking/booking.service.ts'
import * as queries from './catalog.queries.ts'
import type { ServiceInput } from './catalog.schemas.ts'

// Owner and office staff manage the services their contractor offers. Services are never
// deleted: archiving takes one off booking and keeps it on past jobs.

const NOT_ON_LIST = 'That service isn’t on your list.'

type ServiceRow = NonNullable<Awaited<ReturnType<typeof queries.findService>>>

function toService({ archivedAt, ...row }: ServiceRow) {
  return { ...row, archived: archivedAt !== null }
}

export async function list(tenantId: string) {
  return (await queries.listServices(tenantId)).map(toService)
}

export async function add(user: SessionUser, input: ServiceInput) {
  const tenantId = tenantOf(user)
  const service = await queries.insertService(tenantId, {
    ...input,
    description: input.description ?? null,
  })
  await changed(user, 'service.created', service.id)
  return toService(service)
}

export async function update(user: SessionUser, serviceId: string, input: ServiceInput) {
  const service = await queries.updateService(tenantOf(user), serviceId, {
    ...input,
    description: input.description ?? null,
  })
  if (!service) throw new HttpError(404, 'not_found', NOT_ON_LIST)
  await changed(user, 'service.updated', serviceId)
  return toService(service)
}

// Takes the service off booking. Jobs already booked for it keep it. Doing it twice is harmless.
export async function archive(user: SessionUser, serviceId: string) {
  const tenantId = tenantOf(user)
  const archived = await queries.archiveService(tenantId, serviceId)
  if (!archived) return found(await queries.findService(tenantId, serviceId))
  await changed(user, 'service.archived', serviceId)
  return toService(archived)
}

export async function restore(user: SessionUser, serviceId: string) {
  const tenantId = tenantOf(user)
  const restored = await queries.restoreService(tenantId, serviceId)
  if (!restored) return found(await queries.findService(tenantId, serviceId))
  await changed(user, 'service.restored', serviceId)
  return toService(restored)
}

// `ids` must be every active service, each once. Anything else means the list changed under
// the person reordering it.
export async function reorder(user: SessionUser, ids: string[]) {
  const tenantId = tenantOf(user)
  const services = await db.transaction(async (tx) => {
    const active = new Set(await queries.lockActiveServiceIds(tenantId, tx))
    const given = new Set(ids)
    if (
      given.size !== ids.length ||
      given.size !== active.size ||
      !ids.every((id) => active.has(id))
    ) {
      throw new HttpError(
        409,
        'services_changed',
        'Your services changed since this page loaded. Refresh and try again.',
      )
    }
    for (const [sortOrder, id] of ids.entries()) {
      await queries.setSortOrder(tenantId, id, sortOrder, tx)
    }
    await audit.insertUserAction(
      tenantId,
      { actorUserId: user.id, action: 'service.reordered', entityType: 'service', data: { ids } },
      tx,
    )
    return queries.listServices(tenantId, tx)
  })
  emitToTenant(tenantId, 'services.updated', { tenantId })
  return services.map(toService)
}

// Records who changed the service and refreshes open dashboards.
async function changed(user: SessionUser, action: string, serviceId: string) {
  const tenantId = tenantOf(user)
  await audit.insertUserAction(tenantId, {
    actorUserId: user.id,
    action,
    entityType: 'service',
    entityId: serviceId,
  })
  emitToTenant(tenantId, 'services.updated', { tenantId })
}

function found(row: ServiceRow | undefined) {
  if (!row) throw new HttpError(404, 'not_found', NOT_ON_LIST)
  return toService(row)
}
