import { sql } from 'drizzle-orm'
import { env } from '../config/env.ts'
import { hashPassword } from '../modules/accounts/passwords.ts'
import { db, pool } from './client.ts'
import {
  phoneNumbers,
  siteFaqs,
  siteReviews,
  sites,
  subscriptionInvoices,
  tenants,
  users,
} from './schema.ts'
import { seedDispatch } from './seed-dispatch.ts'

// Resets the development database to demo data: one contractor, Desert Breeze Air, whose own
// website is http://desert.site.localhost:3000/. It keeps Relay's default brand colors.
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
    // The demo runs in the Philippines: windows and quiet hours follow Manila time.
    timezone: 'Asia/Manila',
    contactEmail: 'office@desert.test',
    contactPhone: '+16025550142', // the number on the demo website
    perJobFeeCents: 1500, // $15 per recovered job
  })
  .returning()

// The Android phone running httpSMS, when there is one. Texts go out from it.
if (env.SEED_SMS_NUMBER) {
  await db.insert(phoneNumbers).values({ tenantId: desert.id, number: env.SEED_SMS_NUMBER })
}

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

// Desert's website, live at http://desert.site.localhost:3000/ and edited on the Website page.
await db.insert(sites).values({
  tenantId: desert.id,
  design: 'breeze',
  publishedAt: new Date(),
  headline: 'Too hot inside? We’ll bring it back to 76°.',
  intro:
    'AC and heating repair, replacement and upkeep across the Phoenix metro. Book online in about two minutes, or call. We answer 24/7.',
  about:
    'A local crew that works in the Phoenix heat every day. We fix, install and look after central air, heat pumps, furnaces and ductless systems, all major brands.',
  licenseNumber: null, // the demo has no real license
  city: 'Phoenix',
  region: 'AZ',
  citiesServed: [
    'Phoenix',
    'Scottsdale',
    'Tempe',
    'Mesa',
    'Chandler',
    'Gilbert',
    'Glendale',
    'Peoria',
  ],
  emergencyService: true,
})

// Sample reviews, not real customers: the names say so on the page.
await db.insert(siteReviews).values(
  [
    [
      'Dana M. (sample)',
      'Chandler',
      'Our AC quit on a 114° Saturday. I booked online at noon, the tech was here by four, and it was blowing cold by dinner.',
    ],
    [
      'Robert T. (sample)',
      'Mesa',
      'He priced the repair and a new unit side by side and let me choose. No pressure, and the repair has held all summer.',
    ],
    [
      'Priya S. (sample)',
      'Glendale',
      'Got a text when he was on the way, he wore shoe covers, and he showed me the part that failed. Easy from start to finish.',
    ],
  ].map(([authorName, place, body], sortOrder) => ({
    tenantId: desert.id,
    authorName,
    place,
    rating: 5,
    body,
    sortOrder,
  })),
)

await db.insert(siteFaqs).values(
  [
    [
      'How soon can you come out?',
      'The booking page shows every open time window, including same-day ones when we have them. In an emergency, call (602) 555-0142 any hour.',
    ],
    [
      'What does a visit cost?',
      'The booking page shows the diagnostic fee before you confirm. After the diagnosis, your technician gives you a flat-rate price for the repair, and nothing is done until you approve it.',
    ],
    [
      'Should I repair or replace my AC?',
      'Replacing usually makes sense when a system is 12 to 15 years old or more, still runs on R-22 refrigerant, or needs a repair that costs close to half the price of a new one. Your technician will price both so you can decide.',
    ],
    [
      'How often should my system be serviced?',
      'In Phoenix, twice a year: the AC in spring before the heat arrives and the heating in fall. Change standard filters every one to three months, and more often during dust-storm season.',
    ],
    [
      'Which brands do you work on?',
      'All major brands of central air conditioners, heat pumps, furnaces and ductless mini-splits.',
    ],
    ['How do I pay?', 'By card or cash, once the job is done.'],
    [
      'Can I change my appointment?',
      'Yes. Your confirmation text and email both have a link to reschedule or cancel.',
    ],
  ].map(([question, answer], sortOrder) => ({ tenantId: desert.id, question, answer, sortOrder })),
)

// Last month's recovered-job invoice, still to be paid, so the owner's Booking settings and
// the admin console have one to show. The daily billing job makes real ones.
const lastMonth = sql`date_trunc('month', now() at time zone ${desert.timezone}) - interval '1 month'`
await db.insert(subscriptionInvoices).values({
  tenantId: desert.id,
  periodStart: sql`(${lastMonth})::date`,
  periodEnd: sql`(${lastMonth} + interval '1 month')::date`,
  monthlyFeeCents: 0,
  recoveredJobs: 3,
  perJobFeeCents: 1500,
  totalCents: 4500,
})

await pool.end()
console.log(
  'Seeded one contractor, Desert Breeze Air ("desert"), with dispatch demo data. Accounts are listed in src/db/seed.ts.',
)
