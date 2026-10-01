import { randomInt, randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db } from '../src/db/client.ts'
import {
  arrivalWindows,
  customers,
  jobs,
  properties,
  services,
  signInCodes,
  tenants,
  type UserRole,
  users,
} from '../src/db/schema.ts'
import { SESSION_COOKIE } from '../src/middleware/auth.ts'
import * as accounts from '../src/modules/accounts/accounts.service.ts'
import { hashPassword } from '../src/modules/accounts/passwords.ts'

export const PASSWORD = 'correct horse battery staple'

export async function resetDb() {
  await db.execute(sql`truncate table sessions, branding_versions, users, tenants cascade`)
}

export async function createTenant(slug: string) {
  const [tenant] = await db
    .insert(tenants)
    .values({
      slug,
      name: `${slug} HVAC`,
      timezone: 'America/Phoenix',
      contactEmail: `office@${slug}.test`,
      contactPhone: '+14805550100',
    })
    .returning()
  return tenant
}

// The details every technician must have.
const technicianProfile = () => ({
  address: '1 Test St, Phoenix, AZ 85004',
  emergencyContactName: 'Test Contact',
  emergencyContactPhone: '+14805550100',
})

// Every test user gets an email; technicians also get the phone they sign in with.
export async function createUser(role: UserRole, tenantId: string | null) {
  const email = `${role}-${randomUUID()}@test.local`
  const [user] = await db
    .insert(users)
    .values({
      email,
      phone: role === 'technician' ? `+1480${randomInt(1_000_000, 10_000_000)}` : null,
      ...(role === 'technician' ? technicianProfile() : {}),
      name: `Test ${role}`,
      role,
      tenantId,
      passwordHash: await passwordHash(),
    })
    .returning()
  return { ...user, email }
}

// A Tuesday far enough ahead that it is never "in the past". Phoenix has no daylight saving,
// so 8:00 local is always 15:00 UTC.
export const TUESDAY = '2030-01-08'
export const WEDNESDAY = '2030-01-09'

// A contractor ready for dispatch: an office user, two technicians, 8–12 and 12–4 windows on
// Tuesdays and Wednesdays (cap 2), one service, and one customer with a property.
export async function createShop(slug: string) {
  const tenant = await createTenant(slug)
  const office = await createUser('office', tenant.id)
  const mike = await createTechnician(tenant.id, 'Mike')
  const ana = await createTechnician(tenant.id, 'Ana')
  const windows = await db
    .insert(arrivalWindows)
    .values(
      [2, 3].flatMap((weekday) => [
        { tenantId: tenant.id, weekday, startsAt: '08:00', endsAt: '12:00', jobCap: 2 },
        { tenantId: tenant.id, weekday, startsAt: '12:00', endsAt: '16:00', jobCap: 2 },
      ]),
    )
    .returning()
  const byDay = (weekday: number, startsAt: string) =>
    windows.find((w) => w.weekday === weekday && w.startsAt === startsAt)!
  const [service] = await db
    .insert(services)
    .values({ tenantId: tenant.id, name: 'AC repair', priceType: 'diagnostic', priceCents: 8900 })
    .returning()
  const [customer] = await db
    .insert(customers)
    .values({ tenantId: tenant.id, name: 'Maria Lopez', phone: '+16025550111', source: 'office' })
    .returning()
  const [property] = await db
    .insert(properties)
    .values({
      tenantId: tenant.id,
      customerId: customer.id,
      street: '12 Palm St',
      city: 'Phoenix',
      state: 'AZ',
      zip: '85004',
    })
    .returning()
  return {
    tenant,
    office,
    cookie: await signIn(office.email),
    mike,
    ana,
    tueMorning: byDay(2, '08:00:00'),
    tueAfternoon: byDay(2, '12:00:00'),
    wedMorning: byDay(3, '08:00:00'),
    service,
    customer,
    property,
  }
}

export type Shop = Awaited<ReturnType<typeof createShop>>

export async function createTechnician(tenantId: string, name: string) {
  const [user] = await db
    .insert(users)
    .values({
      tenantId,
      role: 'technician',
      name,
      phone: `+1480${randomInt(1_000_000, 10_000_000)}`,
      ...technicianProfile(),
    })
    .returning()
  return user
}

// A booked job straight in the database, for dispatch tests that don't go through booking.
// `at` is the local start of its window in Phoenix, e.g. '2030-01-08 08:00'.
export async function createJob(
  shop: Shop,
  values: Partial<typeof jobs.$inferInsert> & { at?: string; hours?: number } = {},
) {
  const { at = `${TUESDAY} 08:00`, hours = 4, ...rest } = values
  const startsAt = new Date(`${at.replace(' ', 'T')}:00-07:00`)
  const [job] = await db
    .insert(jobs)
    .values({
      tenantId: shop.tenant.id,
      customerId: shop.customer.id,
      propertyId: shop.property.id,
      serviceId: shop.service.id,
      status: 'booked',
      source: 'office',
      problem: 'AC blowing warm air',
      systemType: 'central_ac',
      windowStartsAt: startsAt,
      windowEndsAt: new Date(startsAt.getTime() + hours * 3_600_000),
      bookedAt: new Date(),
      ...rest,
    })
    .returning()
  return job
}

// Starts a session without going through the rate-limited sign-in route.
// Returns the Cookie header for later requests.
export async function signIn(email: string): Promise<string> {
  const { token } = await accounts.signIn(email, PASSWORD)
  return `${SESSION_COOKIE}=${token}`
}

// Starts a technician's session the way a texted code does, without the rate-limited route.
// Returns the Cookie header for later requests.
export async function signInTechnician(technician: {
  id: string
  phone: string | null
}): Promise<string> {
  await db.insert(signInCodes).values({
    userId: technician.id,
    codeHash: accounts.hashCode('123456'),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  })
  const { token } = await accounts.signInWithCode(technician.phone!, '123456')
  return `${SESSION_COOKIE}=${token}`
}

// Hashing is slow on purpose, so the shared test password is hashed once.
let hashed: Promise<string> | undefined
function passwordHash(): Promise<string> {
  hashed ??= hashPassword(PASSWORD)
  return hashed
}
