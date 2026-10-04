import { Router } from 'express'
import { requireRole } from '../../middleware/auth.ts'
import { tenantOf } from '../booking/booking.service.ts'
import { ImportCheck, ImportParams, ImportSave } from './imports.schemas.ts'
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

importsRoutes.get('/customers/imports', staff, async (req, res) => {
  res.json(await imports.list(tenantOf(req.user!)))
})

importsRoutes.post('/customers/imports/:importId/undo', staff, async (req, res) => {
  const { importId } = ImportParams.parse(req.params)
  res.json(await imports.undo(tenantOf(req.user!), importId))
})
