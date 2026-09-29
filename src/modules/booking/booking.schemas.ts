import { z } from 'zod'
import { SYSTEM_TYPES } from '../../db/schema.ts'
import { LocalDate, OptionalEmail, UsPhone, UsState, Zip } from '../../lib/fields.ts'

const NewCustomer = z.object({
  name: z.string().trim().min(1, 'Enter the customer’s name').max(200),
  phone: UsPhone,
  email: OptionalEmail,
})

const NewProperty = z.object({
  street: z.string().trim().min(1, 'Enter the street address').max(200),
  unit: z.string().trim().max(50).optional(),
  city: z.string().trim().min(1, 'Enter the city').max(100),
  state: UsState,
  zip: Zip,
})

// The office books a job by phone. The customer and address are either picked from search
// (customerId, propertyId) or typed in (newCustomer, newProperty).
export const OfficeBookingInput = z
  .object({
    customerId: z.uuid().optional(),
    newCustomer: NewCustomer.optional(),
    propertyId: z.uuid().optional(),
    newProperty: NewProperty.optional(),
    serviceId: z.uuid('Pick a service'),
    date: LocalDate,
    windowId: z.uuid('Pick an arrival window'),
    problem: z.string().trim().min(1, 'Describe the problem').max(2000),
    systemType: z.enum(SYSTEM_TYPES, 'Pick the system type'),
    vulnerableOccupant: z.boolean().default(false),
    consentToTexts: z.boolean().default(false),
    allowOverCap: z.boolean().default(false),
  })
  // Runs even when other fields failed, so an empty form lists everything that's missing at once.
  // It only checks which keys are present, so half-parsed input is safe here.
  .superRefine(
    (input, ctx) => {
      if (!input.customerId === !input.newCustomer) {
        ctx.addIssue({
          code: 'custom',
          path: ['customerId'],
          message: 'Pick a customer or add a new one',
        })
      }
      // A new customer has no saved addresses yet.
      const pickedProperty = input.propertyId && input.customerId
      if (!pickedProperty === !input.newProperty) {
        ctx.addIssue({
          code: 'custom',
          path: ['propertyId'],
          message: 'Pick an address or add a new one',
        })
      }
    },
    { when: ({ value }) => typeof value === 'object' && value !== null },
  )
export type OfficeBookingInput = z.infer<typeof OfficeBookingInput>
