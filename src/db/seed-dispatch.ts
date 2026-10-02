import { sql } from 'drizzle-orm'
import { addBookedLines } from '../modules/charges/charges.service.ts'
import { db } from './client.ts'
import {
  arrivalWindows,
  businessHours,
  consentEvents,
  customers,
  type JOB_SOURCES,
  type JOB_STATUSES,
  jobNotes,
  jobs,
  priceItems,
  properties,
  type SYSTEM_TYPES,
  serviceAreaZips,
  services,
  users,
} from './schema.ts'

// Demo data for the dispatch board: technicians, hours, windows, services, customers, and
// jobs on the contractor's next two working days, so the board is never empty.

type CustomerSeed = {
  name: string
  phone: string
  street: string
  city: string
  zip: string
  equipment?: [brand: string, year: number]
  consent?: boolean
}

type VisitSeed = {
  day: 0 | 1 // first or second working day from today
  window: 'morning' | 'afternoon'
  customer: number // index into customers
  service: number // index into SERVICES
  problem: string
  systemType: (typeof SYSTEM_TYPES)[number]
  technician?: number // index into technicians; unassigned when missing
  status?: (typeof JOB_STATUSES)[number]
  source?: (typeof JOB_SOURCES)[number]
  priority?: boolean
  note?: string
}

export type DispatchSeed = {
  timezone: string
  technicians: [name: string, phone: string, address: string][]
  zips: string[]
  customers: CustomerSeed[]
  visits: VisitSeed[]
}

const SERVICES = [
  { name: 'AC repair', priceType: 'diagnostic', priceCents: 8900 },
  { name: 'Heating repair', priceType: 'diagnostic', priceCents: 8900 },
  { name: 'Tune-up', priceType: 'fixed', priceCents: 12900 },
  { name: 'New-system estimate', priceType: 'free', priceCents: 0 },
] as const

// The demo contractor's repair price list.
const PRICE_ITEMS = [
  { name: 'Capacitor replacement', priceCents: 18500 },
  { name: 'Condenser fan motor', priceCents: 42500 },
  { name: 'Contactor replacement', priceCents: 16500 },
  { name: 'Drain line flush', priceCents: 12000 },
  { name: 'Refrigerant (per lb)', priceCents: 9500 },
  { name: 'Thermostat replacement', priceCents: 21000 },
]

const WINDOWS = { morning: ['08:00', '12:00'], afternoon: ['12:00', '16:00'] } as const
const WORKDAYS = [1, 2, 3, 4, 5, 6] // Monday to Saturday

export async function seedDispatch(tenantId: string, seed: DispatchSeed) {
  const technicians = await db
    .insert(users)
    .values(
      seed.technicians.map(([name, phone, address]) => ({
        tenantId,
        role: 'technician' as const,
        name,
        phone,
        address,
        emergencyContactName: `Emergency contact for ${name}`,
        emergencyContactPhone: '+14805550100',
      })),
    )
    .returning()

  await db
    .insert(businessHours)
    .values(WORKDAYS.map((weekday) => ({ tenantId, weekday, opensAt: '07:00', closesAt: '18:00' })))
  await db.insert(arrivalWindows).values(
    WORKDAYS.flatMap((weekday) =>
      Object.values(WINDOWS).map(([startsAt, endsAt]) => ({
        tenantId,
        weekday,
        startsAt,
        endsAt,
        jobCap: 4,
      })),
    ),
  )
  const serviceRows = await db
    .insert(services)
    .values(SERVICES.map((service, sortOrder) => ({ ...service, tenantId, sortOrder })))
    .returning()
  await db.insert(priceItems).values(PRICE_ITEMS.map((item) => ({ ...item, tenantId })))
  await db.insert(serviceAreaZips).values(seed.zips.map((zip) => ({ tenantId, zip })))

  const customerRows = []
  for (const person of seed.customers) {
    const [customer] = await db
      .insert(customers)
      .values({ tenantId, name: person.name, phone: person.phone, source: 'import' })
      .returning()
    const [property] = await db
      .insert(properties)
      .values({
        tenantId,
        customerId: customer.id,
        street: person.street,
        city: person.city,
        state: 'AZ',
        zip: person.zip,
        equipmentBrand: person.equipment?.[0],
        equipmentYear: person.equipment?.[1],
      })
      .returning()
    if (person.consent) {
      await db.insert(consentEvents).values({
        tenantId,
        contact: person.phone,
        channel: 'sms',
        granted: true,
        source: 'import',
      })
    }
    customerRows.push({ customer, property })
  }

  const days = nextWorkdays(seed.timezone, 2)
  for (const visit of seed.visits) {
    const { customer, property } = customerRows[visit.customer]
    const [startsAt, endsAt] = WINDOWS[visit.window]
    const date = days[visit.day]
    const status = visit.status ?? 'booked'
    const [job] = await db
      .insert(jobs)
      .values({
        tenantId,
        customerId: customer.id,
        propertyId: property.id,
        serviceId: serviceRows[visit.service].id,
        technicianId: visit.technician === undefined ? null : technicians[visit.technician].id,
        status,
        source: visit.source ?? 'office',
        priority: visit.priority ?? false,
        vulnerableOccupant: visit.priority ?? false,
        problem: visit.problem,
        systemType: visit.systemType,
        windowStartsAt: sql`(${date}::date + ${startsAt}::time) at time zone ${seed.timezone}`,
        windowEndsAt: sql`(${date}::date + ${endsAt}::time) at time zone ${seed.timezone}`,
        bookedAt: new Date(),
        completedAt: status === 'done' ? new Date() : null,
      })
      .returning()
    await addBookedLines(tenantId, job.id, db)
    if (visit.note) {
      await db.insert(jobNotes).values({ tenantId, jobId: job.id, body: visit.note })
    }
  }
}

// Today (if it's a working day) and the working days after it, as local dates.
function nextWorkdays(timezone: string, count: number): string[] {
  const format = new Intl.DateTimeFormat('en-CA', { timeZone: timezone })
  const days: string[] = []
  for (let offset = 0; days.length < count; offset++) {
    const date = format.format(new Date(Date.now() + offset * 86_400_000))
    if (WORKDAYS.includes(new Date(`${date}T00:00:00Z`).getUTCDay())) days.push(date)
  }
  return days
}
