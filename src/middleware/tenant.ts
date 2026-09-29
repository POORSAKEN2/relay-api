import type { RequestHandler } from 'express'
import { env } from '../config/env.ts'
import { HttpError } from '../lib/http-error.ts'
import { findTenantByHost, type TenantHost } from '../modules/branding/branding.queries.ts'

// "desert.garified.com" -> { slug: "desert" }, "book.desertbreezeair.com" -> { customDomain }.
// The bare app domain and deeper subdomains ("a.b.garified.com") match nothing.
export function parseTenantHost(host: string, appDomain: string): TenantHost | null {
  const hostname = host.trim().toLowerCase().replace(/:\d+$/, '')
  if (!hostname || hostname === appDomain) return null
  if (!hostname.endsWith(`.${appDomain}`)) return { customDomain: hostname }
  const slug = hostname.slice(0, -(appDomain.length + 1))
  return /^[a-z0-9-]+$/.test(slug) ? { slug } : null
}

// Public routes: the contractor comes from the web app's hostname, sent as X-Tenant-Host.
export const tenantFromHost: RequestHandler = async (req, _res, next) => {
  const host = parseTenantHost(req.get('x-tenant-host') ?? '', env.APP_DOMAIN)
  const tenant = host ? await findTenantByHost(host) : undefined
  if (!tenant) throw new HttpError(404, 'not_found', 'Contractor not found')
  req.tenant = tenant
  next()
}
