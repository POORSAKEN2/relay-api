import { sql } from 'drizzle-orm'
import { env } from '../config/env.ts'
import { hashPassword } from '../modules/accounts/passwords.ts'
import { db, pool } from './client.ts'
import { tenants, users } from './schema.ts'
import { seedDispatch } from './seed-dispatch.ts'

// Resets the development database to demo data: one contractor, Desert Breeze Air, whose own
// website is ../contractor-site. It keeps Relay's default brand colors.
if (env.NODE_ENV === 'production') throw new Error('db:seed must not run in production')

// Local development only: every seeded account signs in with this password.
const DEV_PASSWORD = 'relay-dev-password'

await db.execute(sql`truncate table sessions, branding_versions, users, tenants cascade`)

const passwordHash = await hashPassword(DEV_PASSWORD)

const [desert] = await db
  .insert(tenants)
  .values({
    slug: 'desert',
    name: 'Desert Breeze Air',
    timezone: 'America/Phoenix',
    contactEmail: 'office@desert.test',
    contactPhone: '+16025550142', // the number on contractor-site
  })
  .returning()

await db.insert(users).values([
  { email: 'admin@relay.test', name: 'Relay Admin', role: 'superadmin', passwordHash },
  {
    email: 'owner@desert.test',
    name: 'Desert Owner',
    role: 'owner',
    tenantId: desert.id,
    passwordHash,
  },
  {
    email: 'office@desert.test',
    name: 'Desert Office',
    role: 'office',
    tenantId: desert.id,
    passwordHash,
  },
])

// Day 0 is today (or the next working day), day 1 the working day after.
await seedDispatch(desert.id, {
  timezone: desert.timezone,
  technicians: [
    ['Sam Patel', '+14805550301', '101 Cactus Ln, Phoenix, AZ 85004'],
    ['Rita Gomez', '+14805550302', '202 Mesquite Dr, Tempe, AZ 85281'],
    ['Luis Moreno', '+14805550303', '303 Saguaro Way, Mesa, AZ 85201'],
  ],
  zips: ['85004', '85008', '85014', '85201', '85251', '85281'],
  customers: [
    {
      name: 'Maria Lopez',
      phone: '+16025550111',
      street: '12 Palm St',
      city: 'Phoenix',
      zip: '85004',
      equipment: ['Trane', 2012],
      consent: true,
    },
    {
      name: 'James Carter',
      phone: '+16025550112',
      street: '88 Mesquite Ave',
      city: 'Phoenix',
      zip: '85008',
      equipment: ['Carrier', 2016],
      consent: true,
    },
    {
      name: 'Priya Shah',
      phone: '+14805550113',
      street: '4 Cactus Rd',
      city: 'Mesa',
      zip: '85201',
      consent: true,
    },
    {
      name: 'Tom Nguyen',
      phone: '+14805550114',
      street: '301 Mill Ave',
      city: 'Tempe',
      zip: '85281',
      equipment: ['Lennox', 2008],
    },
    {
      name: 'Evelyn Brooks',
      phone: '+16025550115',
      street: '19 Sunset Dr',
      city: 'Phoenix',
      zip: '85014',
      equipment: ['Goodman', 2005],
      consent: true,
    },
    {
      name: 'Carlos Diaz',
      phone: '+16025550116',
      street: '7 Saguaro Ln',
      city: 'Phoenix',
      zip: '85004',
      consent: true,
    },
    {
      name: 'Olivia Grant',
      phone: '+14805550117',
      street: '6 Camelback Rd',
      city: 'Scottsdale',
      zip: '85251',
      equipment: ['Rheem', 2019],
    },
    {
      name: 'Robert Hale',
      phone: '+14805550118',
      street: '9 Rural Rd',
      city: 'Tempe',
      zip: '85281',
      consent: true,
    },
  ],
  visits: [
    {
      day: 0,
      window: 'morning',
      customer: 0,
      service: 2,
      technician: 0,
      status: 'done',
      problem: 'Yearly tune-up',
      systemType: 'central_ac',
    },
    {
      day: 0,
      window: 'morning',
      customer: 1,
      service: 0,
      technician: 1,
      status: 'in_progress',
      source: 'web',
      problem: 'AC blowing warm air',
      systemType: 'central_ac',
    },
    {
      day: 0,
      window: 'morning',
      customer: 4,
      service: 1,
      priority: true,
      source: 'ai',
      problem: 'No heat, 82-year-old at home',
      systemType: 'furnace',
      note: 'AI call summary: caller’s mother (82) lives alone, furnace stopped overnight. Asked for the earliest visit.',
    },
    {
      day: 0,
      window: 'afternoon',
      customer: 2,
      service: 0,
      technician: 0,
      status: 'en_route',
      source: 'text_back',
      problem: 'Thermostat blank, no cooling',
      systemType: 'heat_pump',
    },
    {
      day: 0,
      window: 'afternoon',
      customer: 3,
      service: 3,
      technician: 2,
      source: 'web',
      problem: 'Wants a quote to replace a 2008 unit',
      systemType: 'central_ac',
    },
    {
      day: 0,
      window: 'afternoon',
      customer: 5,
      service: 0,
      problem: 'Water leaking from the indoor unit',
      systemType: 'mini_split',
    },
    {
      day: 1,
      window: 'morning',
      customer: 6,
      service: 2,
      technician: 1,
      source: 'recovery_text',
      problem: 'Tune-up before summer',
      systemType: 'heat_pump',
    },
    {
      day: 1,
      window: 'morning',
      customer: 7,
      service: 0,
      source: 'ai',
      problem: 'Loud rattling from the outdoor unit',
      systemType: 'central_ac',
    },
    {
      day: 1,
      window: 'afternoon',
      customer: 0,
      service: 1,
      problem: 'Burning smell when the heat turns on',
      systemType: 'furnace',
    },
  ],
})

await pool.end()
console.log(
  'Seeded one contractor, Desert Breeze Air ("desert"), with dispatch demo data. Accounts are listed in src/db/seed.ts.',
)
