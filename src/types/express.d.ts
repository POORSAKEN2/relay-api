import type { Tenant } from '../db/schema.ts'
import type { SessionUser } from '../modules/accounts/accounts.service.ts'

declare global {
  namespace Express {
    interface Request {
      tenant?: Tenant // set by tenantFromHost
      user?: SessionUser // set by requireRole
    }
  }
}
