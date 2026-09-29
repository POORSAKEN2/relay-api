import { z } from 'zod'

export const SignInInput = z.object({
  email: z.email().toLowerCase(),
  password: z.string().min(1).max(200),
})
