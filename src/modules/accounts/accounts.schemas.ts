import { z } from 'zod'
import { UsPhone } from '../../lib/fields.ts'

export const SignInInput = z.object({
  email: z.email().toLowerCase(),
  password: z.string().min(1).max(200),
})

// Technicians type their mobile number in any US format.
export const PhoneCodeInput = z.object({ phone: UsPhone })

export const PhoneSignInInput = z.object({
  phone: UsPhone,
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Enter the 6-digit code'),
})
