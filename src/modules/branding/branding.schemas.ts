import { z } from 'zod'

const HexColor = z
  .string()
  .regex(/^#[0-9a-f]{6}$/i, 'Expected a hex color like #1d4ed8')
  .toLowerCase()

export const TenantParams = z.object({ tenantId: z.uuid() })

export const BrandingInput = z.object({ primaryColor: HexColor, accentColor: HexColor })
export type BrandingInput = z.infer<typeof BrandingInput>
