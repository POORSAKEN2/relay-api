import { z } from 'zod'
import { Email, OptionalPhone } from '../../lib/fields.ts'

// Inviting or editing an owner or office user. They sign in by the emailed link, so the
// email is required. An optional mobile number receives texts about new bookings.
export const StaffInput = z.object({
  name: z.string().trim().min(1, 'Enter their name').max(200),
  email: Email,
  phone: OptionalPhone,
  role: z.enum(['owner', 'office'], 'Pick owner or office'),
})
export type StaffInput = z.infer<typeof StaffInput>

export const StaffParams = z.object({
  staffId: z.uuid('That person isn’t on your staff.'),
})
