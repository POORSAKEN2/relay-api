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

// The customer list's search box, sort and page. Anything odd falls back to the defaults.
export const CustomerListQuery = z.object({
  q: z.string().trim().max(100).default(''),
  sort: z.enum(['name', 'newest']).catch('name'),
  page: z.coerce.number().int().min(1).catch(1),
})
export type CustomerListQuery = z.infer<typeof CustomerListQuery>

// The office adds a customer from the customers screen: the contact, and the address when
// they have it.
export const NewCustomerInput = NewCustomer.extend({ property: NewProperty.optional() })
export type NewCustomerInput = z.infer<typeof NewCustomerInput>

export const CustomerParams = z.object({ customerId: z.uuid('That customer link isn’t valid') })
