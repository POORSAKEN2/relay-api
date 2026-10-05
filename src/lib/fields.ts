import { z } from 'zod'

// Input fields shared by several modules. Messages are shown next to the field as-is.

// A phone as E.164. The demo texts Philippine mobiles; US numbers keep working:
// '0917 123 4567' → '+639171234567', '(480) 555-0199' → '+14805550199', '+63 917…' kept.
export const Phone = z
  .string()
  .trim()
  .transform((value, ctx) => {
    const phone = toE164(value)
    if (!phone) {
      ctx.addIssue({ code: 'custom', message: 'Enter a mobile number, like 0917 123 4567' })
      return z.NEVER
    }
    return phone
  })

function toE164(value: string): string | null {
  const digits = value.replace(/\D/g, '')
  // Typed with a '+': the country code is already there.
  if (value.startsWith('+')) return /^[1-9]\d{7,14}$/.test(digits) ? `+${digits}` : null
  if (/^09\d{9}$/.test(digits)) return `+63${digits.slice(1)}` // PH, local form
  if (/^639\d{9}$/.test(digits)) return `+${digits}` // PH, without the '+'
  // US. A bare 10-digit '917…' lands here too: 917 is also a New York area code.
  const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits
  return /^[2-9]\d{9}$/.test(national) ? `+1${national}` : null
}

// An optional mobile number. Empty means "none", stored as null so an edit can clear it.
export const OptionalPhone = z.preprocess(
  (value) =>
    value === undefined || (typeof value === 'string' && value.trim() === '') ? null : value,
  Phone.nullable(),
)

export const Email = z.email('Enter a valid email address').trim().toLowerCase()

// A blank field means "no email".
export const OptionalEmail = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  Email.optional(),
)

// A local calendar day, '2030-01-08'. Impossible days such as '2030-02-31' are refused.
export const LocalDate = z.string({ error: 'Pick a date' }).refine((value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const day = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(day.getTime()) && day.toISOString().startsWith(value)
}, 'Pick a date')

export const UsState = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, 'Enter a 2-letter state, like AZ')

export const Zip = z
  .string()
  .trim()
  .regex(/^\d{5}$/, 'Enter a 5-digit ZIP code')
