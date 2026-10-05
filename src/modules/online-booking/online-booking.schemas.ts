import { z } from 'zod'
import { SYSTEM_TYPES } from '../../db/schema.ts'
import { LocalDate, OptionalEmail, Phone, UsState, Zip } from '../../lib/fields.ts'

// What a homeowner sends from the booking page. Messages are shown next to the field as-is.

const Name = z.string('Enter your name').trim().min(1, 'Enter your name').max(200)

export const ZipParams = z.object({ zip: Zip })

// Step 2 exit: outside the service area, asks for a call back.
export const CallbackInput = z.object({
  name: Name,
  phone: Phone,
  zip: Zip,
  message: z.string().trim().max(1000, 'Keep the message to 1,000 characters or fewer').optional(),
})
export type CallbackInput = z.infer<typeof CallbackInput>

// Step 3: who is booking. Saved as a draft so an unfinished booking isn't lost. `token` is the
// draft this browser already has, sent when the homeowner comes back to the step.
export const DraftInput = z.object({
  name: Name,
  phone: Phone,
  zip: Zip,
  consent: z.boolean().default(false),
  token: z.string().optional(),
})
export type DraftInput = z.infer<typeof DraftInput>

// The answers a draft keeps (DraftAnswers in schema.ts). Anything else is dropped.
export const DraftAnswersInput = z.object({
  answers: z.object({
    serviceId: z.uuid().optional(),
    problem: z.string().trim().max(2000).optional(),
    systemType: z.enum(SYSTEM_TYPES).optional(),
    vulnerableOccupant: z.boolean().optional(),
    priorityService: z.boolean().optional(),
  }),
})

// Step 5 exit: no arrival window works, asks for a text when one opens.
export const WaitlistInput = z.object({
  serviceId: z.uuid('Pick a service'),
  zip: Zip,
  name: Name,
  phone: Phone,
  vulnerableOccupant: z.boolean().default(false),
  consent: z.literal(true, 'Tick the box so we can text you when a time opens'),
})
export type WaitlistInput = z.infer<typeof WaitlistInput>

// Step 6: everything the wizard collected. Books the arrival window.
export const BookingInput = z.object({
  serviceId: z.uuid('Pick a service'),
  date: LocalDate,
  windowId: z.uuid('Pick an arrival window'),
  problem: z.string('Describe the problem').trim().min(1, 'Describe the problem').max(2000),
  systemType: z.enum(SYSTEM_TYPES, 'Pick the system type'),
  vulnerableOccupant: z.boolean().default(false),
  priorityService: z.boolean().default(false),
  name: Name,
  phone: Phone,
  email: OptionalEmail,
  street: z.string('Enter the street address').trim().min(1, 'Enter the street address').max(200),
  unit: z.string().trim().max(50).optional(),
  city: z.string('Enter the city').trim().min(1, 'Enter the city').max(100),
  state: UsState,
  zip: Zip,
  consent: z.boolean().default(false),
  draftToken: z.string().optional(), // the draft this booking finishes, when there is one
  offerToken: z.string().max(64).optional(), // the waitlist offer this booking takes
})
export type BookingInput = z.infer<typeof BookingInput>

export const PhotoParams = z.object({ photoId: z.uuid('That photo link isn’t valid') })

// The manage page: a new arrival window for a booked visit.
export const RescheduleInput = z.object({
  date: LocalDate,
  windowId: z.uuid('Pick an arrival window'),
})
export type RescheduleInput = z.infer<typeof RescheduleInput>
