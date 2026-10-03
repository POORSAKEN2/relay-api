import { env } from '../config/env.ts'

// The address of a page on a contractor's site: their own domain once it is verified, else
// their subdomain. Always https with no port, which is wrong on a developer's machine; fine
// while texts are only saved (docs/real-texting-todo.md).
export function tenantUrl(
  tenant: { slug: string; customDomain: string | null; customDomainVerifiedAt: Date | null },
  path: string,
) {
  const host =
    tenant.customDomain && tenant.customDomainVerifiedAt
      ? tenant.customDomain
      : `${tenant.slug}.${env.APP_DOMAIN}`
  return `https://${host}${path}`
}
