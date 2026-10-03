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
