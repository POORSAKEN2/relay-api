import { z } from 'zod'
import { Email, OptionalEmail, Phone, UsState, Zip } from '../../lib/fields.ts'

// Contact and address rules for every way a customer is added or changed: the office's
// booking form, the customers screen and, later, spreadsheet import.

export const NewCustomer = z.object({
  name: z.string().trim().min(1, 'Enter the customer’s name').max(200),
  phone: Phone,
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

// A blank box saves as nothing (null); a field left out isn't touched (undefined).
function blankToNull(value: unknown) {
  return typeof value === 'string' && value.trim() === '' ? null : value
}

function optionalText(max: number, message: string) {
  return z.preprocess(blankToNull, z.string().trim().max(max, message).nullish())
}

// A customer's notes. A blank box saves as nothing.
export const CustomerNotes = optionalText(2000, 'Keep the notes under 2,000 characters')

// Changing a customer: the contact dialog sends name, phone and email; the notes card sends
// notes. A blank email or notes box clears it.
export const CustomerChanges = z
  .object({
    name: NewCustomer.shape.name.optional(),
    phone: Phone.optional(),
    email: z.preprocess(blankToNull, Email.nullish()),
    notes: CustomerNotes,
  })
  .refine(
    (changes) => Object.values(changes).some((value) => value !== undefined),
    'Nothing to save',
  )
export type CustomerChanges = z.infer<typeof CustomerChanges>

// The address dialog: the address, its equipment and access notes, always the whole form.
// The equipment's age is saved as its install year, so it grows older on its own.
export const PropertyInput = NewProperty.extend({
  equipmentBrand: optionalText(50, 'Keep the brand under 50 characters'),
  equipmentYear: z
    .number('Check the equipment age')
    .int('Check the equipment age')
    .min(1950, 'Check the equipment age')
    .refine((year) => year <= new Date().getFullYear(), 'Check the equipment age')
    .nullish(),
  notes: optionalText(1000, 'Keep the access notes under 1,000 characters'),
})
export type PropertyInput = z.infer<typeof PropertyInput>

export const PropertyParams = CustomerParams.extend({
  propertyId: z.uuid('That address link isn’t valid'),
})
