import { z } from 'zod'
import { OptionalEmail, Phone } from '../../lib/fields.ts'

// Adding or editing a technician. The phone is how they'll sign in and get job texts.
export const TechnicianInput = z.object({
  name: z.string().trim().min(1, 'Enter the technician’s name').max(200),
  phone: Phone,
  email: OptionalEmail,
  address: z.string().trim().min(1, 'Enter the technician’s address').max(500),
  emergencyContactName: z.string().trim().min(1, 'Enter an emergency contact name').max(200),
  emergencyContactPhone: Phone,
})
export type TechnicianInput = z.infer<typeof TechnicianInput>

export const TechnicianParams = z.object({
  technicianId: z.uuid('That technician isn’t on your team.'),
})
