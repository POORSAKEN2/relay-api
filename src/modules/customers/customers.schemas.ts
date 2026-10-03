import { z } from 'zod'
import { OptionalEmail, UsPhone, UsState, Zip } from '../../lib/fields.ts'

// Contact and address rules for every way a customer is added or changed: the office's
// booking form, the customers screen and, later, spreadsheet import.

export const NewCustomer = z.object({
  name: z.string().trim().min(1, 'Enter the customer’s name').max(200),
  phone: UsPhone,
  email: OptionalEmail,
})

export const NewProperty = z.object({
  street: z.string().trim().min(1, 'Enter the street address').max(200),
  unit: z.string().trim().max(50).optional(),
  city: z.string().trim().min(1, 'Enter the city').max(100),
  state: UsState,
  zip: Zip,
})
export type NewProperty = z.infer<typeof NewProperty>
