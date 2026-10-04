import { type Db, db } from '../../db/client.ts'
import { HttpError } from '../../lib/http-error.ts'
import type { SessionUser } from '../accounts/accounts.service.ts'
import { tenantOf } from '../booking/booking.service.ts'
import { customerMatchKey } from './customer-match.ts'
import { type ReadyRow, readImportRow } from './import-rows.ts'
import * as queries from './imports.queries.ts'
import type { ImportCheck, ImportSave } from './imports.schemas.ts'

type RowStatus = 'ready' | 'existing' | 'repeated' | 'invalid'
type SortedRow = { row: number; status: RowStatus; problems: string[]; ready?: ReadyRow }

// Reads every row and sorts it: ready to import, already in Relay (same phone and name),
// repeated earlier in the file, or invalid with the reasons.
async function sortRows(tenantId: string, input: ImportCheck, tx: Db): Promise<SortedRow[]> {
  const readings = input.rows.map((row) => ({
    row: row.row,
    reading: readImportRow(row, input.addressInOneColumn),
  }))
  const phones = [
    ...new Set(
      readings.flatMap(({ reading }) => (reading.ok ? [reading.value.customer.phone] : [])),
    ),
  ]
  const inRelay = new Set(
    (await queries.listCustomersByPhones(tenantId, phones, tx)).map((customer) =>
      customerMatchKey(customer.phone ?? '', customer.name),
    ),
  )
  const seen = new Set<string>()
  return readings.map(({ row, reading }): SortedRow => {
    if (!reading.ok) return { row, status: 'invalid', problems: reading.problems }
    const key = customerMatchKey(reading.value.customer.phone, reading.value.customer.name)
    if (inRelay.has(key)) return { row, status: 'existing', problems: [] }
    if (seen.has(key)) return { row, status: 'repeated', problems: [] }
    seen.add(key)
    return { row, status: 'ready', problems: [], ready: reading.value }
  })
}

function countByStatus(rows: SortedRow[]) {
  const counts = { ready: 0, existing: 0, repeated: 0, invalid: 0 }
  for (const row of rows) counts[row.status] += 1
  return counts
}

// The office's preview: what would happen to each row. Saves nothing.
export async function check(tenantId: string, input: ImportCheck) {
  const rows = await sortRows(tenantId, input, db)
  return { rows: rows.map(({ ready: _, ...row }) => row), counts: countByStatus(rows) }
}

// Imports the ready rows as one batch. Sorts the rows again instead of trusting the preview,
// since customers may have been added in between.
export async function save(user: SessionUser, input: ImportSave) {
  const tenantId = tenantOf(user)
  return db.transaction(async (tx) => {
    const rows = await sortRows(tenantId, input, tx)
    const ready = rows.flatMap((row) => (row.ready ? [row.ready] : []))
    if (ready.length === 0) {
      throw new HttpError(422, 'nothing_to_import', 'Nothing to import: no row is ready.')
    }
    const counts = countByStatus(rows)
    const batch = await queries.insertImport(
      tenantId,
      {
        createdBy: user.id,
        fileName: input.fileName,
        createdCount: ready.length,
        skippedCount: rows.length - ready.length,
      },
      tx,
    )
    await queries.insertImportedCustomers(tenantId, batch.id, ready, tx)
    return {
      importId: batch.id,
      created: counts.ready,
      existing: counts.existing,
      repeated: counts.repeated,
      invalid: counts.invalid,
    }
  })
}

// Past imports shows this many.
const IMPORTS_SHOWN = 20

export async function list(tenantId: string) {
  return { imports: await queries.listImports(tenantId, IMPORTS_SHOWN) }
}

// Takes an import back: removes the customers it added, except any with history since.
export async function undo(tenantId: string, importId: string) {
  return db.transaction(async (tx) => {
    const batch = await queries.lockImport(tenantId, importId, tx)
    if (!batch) throw new HttpError(404, 'not_found', 'That import wasn’t found.')
    if (batch.undoneAt) {
      throw new HttpError(409, 'already_undone', 'This import was already undone.')
    }
    const removed = await queries.removeImportedCustomers(tenantId, importId, tx)
    const kept = await queries.countImportedCustomers(tenantId, importId, tx)
    await queries.markUndone(tenantId, importId, kept, tx)
    return { removed, kept }
  })
}
