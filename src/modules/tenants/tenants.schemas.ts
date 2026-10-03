import { z } from 'zod'
import { TENANT_STATUSES } from '../../db/schema.ts'
import { UsPhone } from '../../lib/fields.ts'

export type TenantStatus = (typeof TENANT_STATUSES)[number]

// Hostnames Relay uses or will use. The database refuses admin, api and www too; checking
// here turns them into a field error instead of a 500.
export const RESERVED_SLUGS = ['admin', 'api', 'app', 'mail', 'relay', 'www']

const TIMEZONES = new Set(Intl.supportedValuesOf('timeZone'))

// Trimmed and lowercased before the format check, so ' Casey@X.test ' is accepted.
const Email = z.string().trim().toLowerCase().pipe(z.email('Enter a valid email address'))

export const CreateTenantInput = z.object({
  name: z.string().trim().min(1, 'Enter the company name').max(100),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(
      /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/,
      'Use lowercase letters, numbers and dashes, not at the start or end',
    )
    .refine((slug) => !RESERVED_SLUGS.includes(slug), 'That address is reserved. Pick another.'),
  timezone: z.string().refine((zone) => TIMEZONES.has(zone), 'Pick a time zone'),
  contactEmail: Email,
  contactPhone: UsPhone,
  owner: z.object({
    name: z.string().trim().min(1, 'Enter the owner’s name').max(100),
    email: Email,
  }),
})
export type CreateTenantInput = z.infer<typeof CreateTenantInput>

export const TenantStatusInput = z.object({
  status: z.enum(TENANT_STATUSES, 'Pick setup, live or suspended'),
})
