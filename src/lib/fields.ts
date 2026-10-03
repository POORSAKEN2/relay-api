import { z } from 'zod'

// Input fields shared by several modules. Messages are shown next to the field as-is.

// '(480) 555-0199' → '+14805550199'. US numbers only for now.
export const UsPhone = z
  .string()
  .trim()
  .transform((value, ctx) => {
    const digits = value.replace(/\D/g, '')
    const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits
    if (!/^[2-9]\d{9}$/.test(national)) {
      ctx.addIssue({ code: 'custom', message: 'Enter a 10-digit phone number' })
      return z.NEVER
    }
    return `+1${national}`
  })

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
