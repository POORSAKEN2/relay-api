import { db } from '../../db/client.ts'
import type { SessionUser } from '../accounts/accounts.service.ts'
import * as audit from '../audit/audit.queries.ts'
import { tenantOf } from '../booking/booking.service.ts'
import * as queries from './settings.queries.ts'

// Owner and office staff set what online booking charges for priority service and which ZIP
// codes it accepts. Service prices are set on the Services screen (catalog module).

export async function getBookingSettings(tenantId: string) {
  const [priorityFeeCents, zips] = await Promise.all([
    queries.findPriorityFee(tenantId),
    queries.listZips(tenantId),
  ])
  return { priorityFeeCents, zips }
}

export async function setPriorityFee(user: SessionUser, priorityFeeCents: number) {
  const tenantId = tenantOf(user)
  await queries.setPriorityFee(tenantId, priorityFeeCents)
  await audit.insertUserAction(tenantId, {
    actorUserId: user.id,
    action: 'settings.priority_fee_updated',
    entityType: 'tenant',
    entityId: tenantId,
    data: { priorityFeeCents },
  })
  return getBookingSettings(tenantId)
}

// `zips` becomes the whole service area. A ZIP code listed twice is saved once.
export async function setServiceArea(user: SessionUser, zips: string[]) {
  const tenantId = tenantOf(user)
  const unique = [...new Set(zips)]
  await db.transaction(async (tx) => {
    await queries.replaceZips(tenantId, unique, tx)
    await audit.insertUserAction(
      tenantId,
      {
        actorUserId: user.id,
        action: 'settings.service_area_updated',
        entityType: 'tenant',
        entityId: tenantId,
        data: { zips: unique.length },
      },
      tx,
    )
  })
  return getBookingSettings(tenantId)
}
