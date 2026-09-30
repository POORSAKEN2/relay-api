import { type Db, db } from '../../db/client.ts'
import { auditEvents } from '../../db/schema.ts'

type UserAction = {
  actorUserId: string
  action: string // 'job.booked', 'job.assigned', …
  entityType: string // 'job', 'customer', …
  entityId?: string // left out when the action covers several rows, like a reorder
  data?: Record<string, unknown>
}

// Append-only: rows are never updated or deleted (a trigger enforces it).
export async function insertUserAction(tenantId: string | null, event: UserAction, tx: Db = db) {
  await tx.insert(auditEvents).values({ tenantId, actorType: 'user', ...event })
}

// Something a homeowner did on the booking page. They have no account, so there is no actor id.
export async function insertHomeownerAction(
  tenantId: string,
  event: Omit<UserAction, 'actorUserId'>,
  tx: Db = db,
) {
  await tx.insert(auditEvents).values({ tenantId, actorType: 'homeowner', ...event })
}
