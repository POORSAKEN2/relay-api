import { z } from 'zod'
import { Phone } from '../../lib/fields.ts'

// A pretend call. No number = a caller who hid their caller ID.
export const StartInput = z.object({ fromPhone: Phone.optional() })

export const TurnInput = z.object({
  text: z.string('Say something').trim().min(1, 'Say something').max(1000),
})

export const CallParams = z.object({ callId: z.uuid('That call link isn’t valid') })
