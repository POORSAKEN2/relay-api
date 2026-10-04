import { and, asc, eq, getTableColumns, gt, ne, type SQL } from 'drizzle-orm'
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core'
import { db } from '../../db/client.ts'
import { customers, invoices, jobs, messages, properties } from '../../db/schema.ts'

type ExportTable = PgTable & { id: PgColumn; tenantId: PgColumn }

type TableSpec = {
  file: string // the CSV inside the ZIP: "customers.csv"
  table: ExportTable
  omit?: string[] // columns left out (property names), like link hashes
  where?: SQL // rows left out
}

// One CSV per table. The tenant filter is added below, never here.
export const EXPORT_TABLES: TableSpec[] = [
  { file: 'customers.csv', table: customers },
  { file: 'properties.csv', table: properties },
  // The hashes are the technician and homeowner link secrets.
  { file: 'jobs.csv', table: jobs, omit: ['techLinkHash', 'manageLinkHash'] },
  // Sign-in code texts hold a live login code.
  { file: 'messages.csv', table: messages, where: ne(messages.kind, 'sign_in_code') },
  { file: 'invoices.csv', table: invoices },
]

export const BATCH_SIZE = 1000

// The columns a table exports, as { propertyName: column }.
export function exportColumns(spec: TableSpec): Record<string, PgColumn> {
  const all: Record<string, PgColumn> = getTableColumns(spec.table)
  return Object.fromEntries(Object.entries(all).filter(([key]) => !spec.omit?.includes(key)))
}

// The next batch of this contractor's rows after `afterId`, in id order. Paging by id keeps
// every query small and fast however large the table is.
export async function listBatch(
  spec: TableSpec,
  tenantId: string,
  afterId: string | null,
): Promise<Record<string, unknown>[]> {
  const { table } = spec
  return db
    .select(exportColumns(spec))
    .from(table)
    .where(
      and(eq(table.tenantId, tenantId), afterId ? gt(table.id, afterId) : undefined, spec.where),
    )
    .orderBy(asc(table.id))
    .limit(BATCH_SIZE)
}
