import { db } from '../../db/client.ts'
import { sendEmail } from '../../lib/email.ts'
import { HttpError } from '../../lib/http-error.ts'
import { logger } from '../../lib/logger.ts'
import { tenantUrl } from '../../lib/tenant-url.ts'
import { emitToTenant } from '../../realtime/index.ts'
import { createSignInLink, type SessionUser } from '../accounts/accounts.service.ts'
import * as audit from '../audit/audit.queries.ts'
import { tenantOf } from '../booking/booking.service.ts'
import * as queries from './staff.queries.ts'
import type { StaffInput } from './staff.schemas.ts'
import { saveOrExplain } from './team.service.ts'

// Owner and office staff manage the contractor's owner and office accounts. Like technicians,
// they are never deleted: deactivating keeps their name on past work.
// An owner can manage anyone. Office staff can manage office staff only, so nobody can
// promote themselves, and nobody can lock themselves out.

const NOT_ON_STAFF = 'That person isn’t on your staff.'

type StaffRow = NonNullable<Awaited<ReturnType<typeof queries.findStaff>>>

function toStaff({ disabledAt, ...row }: StaffRow) {
  return { ...row, active: disabledAt === null }
}

export async function list(tenantId: string) {
  return (await queries.listStaff(tenantId)).map(toStaff)
}

export async function invite(user: SessionUser, input: StaffInput) {
  const tenantId = tenantOf(user)
  if (user.role !== 'owner' && input.role === 'owner') throw onlyOwners()
  const { id } = await saveOrExplain(() => queries.insertStaff(tenantId, input))
  await audit.insertUserAction(tenantId, {
    actorUserId: user.id,
    action: 'user.created',
    entityType: 'user',
    entityId: id,
    data: { role: input.role },
  })
  // The person is saved even if the email fails: the office can send the link again.
  let emailSent = true
  try {
    await emailLink(tenantId, { id, name: input.name, email: input.email })
  } catch (error) {
    logger.error({ err: error, userId: id }, 'Could not email the sign-in link')
    emailSent = false
  }
  emitToTenant(tenantId, 'team.updated', { tenantId })
  return { person: found(await queries.findStaff(tenantId, id)), emailSent }
}

export async function update(user: SessionUser, staffId: string, input: StaffInput) {
  const tenantId = tenantOf(user)
  const current = await mayManage(user, staffId)
  if (user.role !== 'owner' && input.role === 'owner') throw onlyOwners()
  if (staffId === user.id && input.role !== current.role) {
    throw new HttpError(409, 'own_role', 'You can’t change your own role.')
  }
  const updated = await saveOrExplain(() => queries.updateStaff(tenantId, staffId, input))
  if (!updated) throw new HttpError(404, 'not_found', NOT_ON_STAFF)
  // A link emailed to the old address must not work any more.
  if (input.email !== current.email) await queries.endLinks(staffId)
  await audit.insertUserAction(tenantId, {
    actorUserId: user.id,
    action: 'user.updated',
    entityType: 'user',
    entityId: staffId,
    data: input.role !== current.role ? { role: input.role } : undefined,
  })
  emitToTenant(tenantId, 'team.updated', { tenantId })
  return found(await queries.findStaff(tenantId, staffId))
}

// Signs the person out and stops them signing in. Doing it twice is harmless.
export async function deactivate(user: SessionUser, staffId: string) {
  const tenantId = tenantOf(user)
  if (staffId === user.id) {
    throw new HttpError(409, 'own_account', 'You can’t deactivate your own account.')
  }
  await db.transaction(async (tx) => {
    const person = await queries.lockStaff(tenantId, staffId, tx)
    if (!person) throw new HttpError(404, 'not_found', NOT_ON_STAFF)
    if (user.role !== 'owner' && person.role === 'owner') throw onlyOwners()
    await queries.endAccess(staffId, tx)
    if (!person.disabledAt) {
      await queries.updateStaff(tenantId, staffId, { disabledAt: new Date() }, tx)
    }
    await audit.insertUserAction(
      tenantId,
      { actorUserId: user.id, action: 'user.deactivated', entityType: 'user', entityId: staffId },
      tx,
    )
  })
  emitToTenant(tenantId, 'team.updated', { tenantId })
  return found(await queries.findStaff(tenantId, staffId))
}

export async function reactivate(user: SessionUser, staffId: string) {
  const tenantId = tenantOf(user)
  await mayManage(user, staffId)
  await queries.updateStaff(tenantId, staffId, { disabledAt: null })
  await audit.insertUserAction(tenantId, {
    actorUserId: user.id,
    action: 'user.reactivated',
    entityType: 'user',
    entityId: staffId,
  })
  emitToTenant(tenantId, 'team.updated', { tenantId })
  return found(await queries.findStaff(tenantId, staffId))
}

// Emails a new sign-in link; the one before it stops working. For an invite that was lost,
// or for someone who has no password to sign in with.
export async function sendLink(user: SessionUser, staffId: string) {
  const tenantId = tenantOf(user)
  const person = await mayManage(user, staffId)
  if (person.disabledAt) {
    throw new HttpError(409, 'deactivated', 'Reactivate them before sending a sign-in link.')
  }
  try {
    await emailLink(tenantId, person)
  } catch (error) {
    logger.error({ err: error, userId: staffId }, 'Could not email the sign-in link')
    throw new HttpError(502, 'email_failed', 'The email could not be sent. Try again.')
  }
  await audit.insertUserAction(tenantId, {
    actorUserId: user.id,
    action: 'user.link_sent',
    entityType: 'user',
    entityId: staffId,
  })
  return found(await queries.findStaff(tenantId, staffId))
}

async function emailLink(
  tenantId: string,
  person: { id: string; name: string; email: string | null },
) {
  const tenant = await queries.findTenant(tenantId)
  if (!tenant || !person.email) throw new Error(`No contractor or email for ${person.id}`)
  const token = await createSignInLink(person.id)
  const link = tenantUrl(tenant, `/sign-in/link?token=${token}`)
  await sendEmail({
    to: person.email,
    subject: `${tenant.name}: your sign-in link`,
    text: `Hi ${person.name},\n\nUse this link to sign in to ${tenant.name} on Relay. It works once and expires in 7 days:\n\n${link}\n\nIf you weren’t expecting this, you can ignore this email.`,
  })
}

// The person to change, if the signed-in user may change them.
async function mayManage(user: SessionUser, staffId: string) {
  const person = await queries.findStaff(tenantOf(user), staffId)
  if (!person) throw new HttpError(404, 'not_found', NOT_ON_STAFF)
  if (user.role !== 'owner' && person.role === 'owner') throw onlyOwners()
  return person
}

function onlyOwners() {
  return new HttpError(403, 'forbidden', 'Only an owner can do that to an owner.')
}

function found(row: StaffRow | undefined) {
  if (!row) throw new HttpError(404, 'not_found', NOT_ON_STAFF)
  return toStaff(row)
}
