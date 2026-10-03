import { randomInt } from 'node:crypto'
import { db } from '../../db/client.ts'
import { violatedUniqueConstraint } from '../../lib/db-errors.ts'
import { HttpError } from '../../lib/http-error.ts'
import type { SessionUser } from '../accounts/accounts.service.ts'
import { hashPassword } from '../accounts/passwords.ts'
import * as audit from '../audit/audit.queries.ts'
import * as queries from './tenants.queries.ts'
import type { CreateTenantInput } from './tenants.schemas.ts'

// The superadmin adds contractors and turns them on and off. Contractors are never deleted.

// No 0/O or 1/l/I: the admin may read it out or retype it.
const PASSWORD_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const PASSWORD_LENGTH = 12

export function generateTemporaryPassword(): string {
  return Array.from(
    { length: PASSWORD_LENGTH },
    () => PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)],
  ).join('')
}

export function listTenants() {
  return queries.listTenants()
}

// Adds a contractor in `setup` with its first owner. The owner's temporary password is
// returned here only: it's stored hashed and never logged.
export async function createTenant(admin: SessionUser, input: CreateTenantInput) {
  const { owner: ownerInput, ...tenantInput } = input
  const temporaryPassword = generateTemporaryPassword()
  const passwordHash = await hashPassword(temporaryPassword)
  try {
    return await db.transaction(async (tx) => {
      const tenant = await queries.insertTenant(tenantInput, tx)
      const owner = await queries.insertOwner(
        { tenantId: tenant.id, ...ownerInput, passwordHash },
        tx,
      )
      await audit.insertUserAction(
        tenant.id,
        {
          actorUserId: admin.id,
          action: 'tenant.created',
          entityType: 'tenant',
          entityId: tenant.id,
          data: { slug: tenant.slug, ownerUserId: owner.id },
        },
        tx,
      )
      return { tenant, owner: { ...owner, temporaryPassword } }
    })
  } catch (error) {
    const constraint = violatedUniqueConstraint(error)
    if (constraint === 'tenants_slug_unique') {
      throw new HttpError(409, 'slug_taken', 'That address is taken. Pick another.')
    }
    if (constraint === 'users_email_unique') {
      throw new HttpError(409, 'email_taken', 'That email already has an account.')
    }
    throw error
  }
}
