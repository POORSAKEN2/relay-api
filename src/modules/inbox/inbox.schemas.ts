import { z } from 'zod'
import { Phone } from '../../lib/fields.ts'

// A thread is every text with one phone number.
export const ThreadQuery = z.object({ contact: Phone })

export const ReplyInput = z.object({
  contact: Phone,
  // 640 characters is four SMS segments: room for a real answer, not a newsletter.
  body: z
    .string('Type a reply')
    .trim()
    .min(1, 'Type a reply')
    .max(640, 'Keep it to 640 characters'),
})
export type ReplyInput = z.infer<typeof ReplyInput>

export const ReadInput = z.object({ contact: Phone })
