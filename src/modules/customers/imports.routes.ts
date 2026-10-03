import { Router } from 'express'
import { requireRole } from '../../middleware/auth.ts'
import { tenantOf } from '../booking/booking.service.ts'
import { ImportCheck, ImportSave } from './imports.schemas.ts'
import * as imports from './imports.service.ts'

// Spreadsheet import. Mounted before customersRoutes so '/customers/imports' is never read as
// a customer id; app.ts gives these routes a 5 MB body limit.
export const importsRoutes = Router()

const staff = requireRole('owner', 'office')

importsRoutes.post('/customers/imports/check', staff, async (req, res) => {
  const input = ImportCheck.parse(req.body)
  res.json(await imports.check(tenantOf(req.user!), input))
})

importsRoutes.post('/customers/imports', staff, async (req, res) => {
  const input = ImportSave.parse(req.body)
  res.status(201).json(await imports.save(req.user!, input))
})
