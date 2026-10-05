import cors from 'cors'
import { Router } from 'express'
import { z } from 'zod'
import { env } from '../../config/env.ts'
import { HttpError } from '../../lib/http-error.ts'
import { parseTenantHost } from '../../middleware/tenant.ts'
import { findTenantByHost } from '../branding/branding.queries.ts'
import { getBranding } from '../branding/branding.service.ts'

// The booking button on a contractor's own website (relay-web's widget.js) asks how to look.
// Any website may ask, so this route has its own open CORS rule and is mounted before the
// app's cookie CORS (app.ts). It answers with public facts only. `host` is the booking page's
// hostname, sent in the address rather than as X-Tenant-Host so the browser needs no
// preflight.
export const widgetRoutes = Router()

const WidgetQuery = z.object({ host: z.string().min(1).max(253) })

widgetRoutes.get('/api/online-booking/widget', cors({ origin: '*' }), async (req, res) => {
  const { host } = WidgetQuery.parse(req.query)
  const where = parseTenantHost(host, env.APP_DOMAIN)
  const tenant = where ? await findTenantByHost(where) : undefined
  if (!tenant) throw new HttpError(404, 'not_found', 'Contractor not found')
  const { primaryColor } = await getBranding(tenant)
  // A new brand color reaches the button within 5 minutes.
  res.set('Cache-Control', 'public, max-age=300')
  res.json({ primaryColor, open: tenant.status !== 'suspended' })
})
