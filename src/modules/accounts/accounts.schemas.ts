import { z } from 'zod'
import { UsPhone } from '../../lib/fields.ts'

export const SignInInput = z.object({
  email: z.email().toLowerCase(),
  password: z.string().min(1).max(200),
})

// Technicians type their mobile number in any US format.
export const PhoneCodeInput = z.object({ phone: UsPhone })
