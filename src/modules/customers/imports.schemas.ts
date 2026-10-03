import { z } from 'zod'

// What the web app sends for one spreadsheet row: its line number in the file and the text of
// each matched cell. Reading and checking the values is import-rows.ts's job.
const Cell = z.string().max(2000, 'A cell is over 2,000 characters').optional()

export const ImportRow = z.object({
  row: z.number().int().min(1),
  name: Cell,
  lastName: Cell,
  phone: Cell,
  email: Cell,
  street: Cell,
  unit: Cell,
  city: Cell,
  state: Cell,
  zip: Cell,
  address: Cell, // the whole address in one cell
  equipmentBrand: Cell,
  equipmentAge: Cell,
  accessNotes: Cell,
  notes: Cell,
})
export type ImportRow = z.infer<typeof ImportRow>

export const IMPORT_ROW_LIMIT = 5000

export const ImportCheck = z.object({
  addressInOneColumn: z.boolean().default(false),
  rows: z
    .array(ImportRow)
    .min(1, 'The file has no rows to import')
    .max(IMPORT_ROW_LIMIT, 'Import up to 5,000 rows at a time'),
})
export type ImportCheck = z.infer<typeof ImportCheck>

export const ImportSave = ImportCheck.extend({
  fileName: z.string().trim().min(1, 'Name the file').max(200),
})
export type ImportSave = z.infer<typeof ImportSave>

export const ImportParams = z.object({ importId: z.uuid('That import link isn’t valid') })
