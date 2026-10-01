import type { Db } from '../../db/client.ts'
import type { PRICE_TYPES } from '../../db/schema.ts'
import * as queries from './charges.queries.ts'

// A job's charges: the booked lines (the service, and priority service when chosen) and the
// repairs a technician adds from the price list, which the homeowner approves or declines.
// The invoice (part 5, step 2) is the approved lines.

// The booked service's line, named by how the service is priced.
export function serviceLineDescription(
  name: string,
  priceType: (typeof PRICE_TYPES)[number],
): string {
  if (priceType === 'diagnostic') return `${name} (diagnostic fee)`
  if (priceType === 'free') return `${name} (free)`
  return name
}

// Writes a newly booked job's lines, in the booking's transaction. Prices are frozen here.
export async function addBookedLines(tenantId: string, jobId: string, tx: Db) {
  const source = await queries.findBookedLineSource(tenantId, jobId, tx)
  const booked = { jobId, quantity: 1, status: 'approved' as const }
  const lines = [
    {
      ...booked,
      description: serviceLineDescription(source.serviceName, source.priceType),
      unitPriceCents: source.priceType === 'free' ? 0 : source.priceCents,
    },
  ]
  if (source.priorityFeeCents > 0) {
    lines.push({
      ...booked,
      description: queries.PRIORITY_LINE,
      unitPriceCents: source.priorityFeeCents,
    })
  }
  await queries.insertLines(tenantId, lines, tx)
}

type LineRow = Awaited<ReturnType<typeof queries.listLines>>[number]

// Each line's total and the two sums: what the homeowner agreed to, and what waits for them.
export function summarize(rows: LineRow[]) {
  const lines = rows.map((line) => ({
    ...line,
    totalCents: line.quantity * line.unitPriceCents,
    // Only a repair still waiting for the homeowner can come off the job. Booked lines are
    // approved from the start.
    removable: line.status === 'proposed',
  }))
  const sum = (status: LineRow['status']) =>
    lines
      .filter((line) => line.status === status)
      .reduce((total, line) => total + line.totalCents, 0)
  return { lines, approvedTotalCents: sum('approved'), proposedTotalCents: sum('proposed') }
}

export async function getCharges(tenantId: string, jobId: string) {
  return summarize(await queries.listLines(tenantId, jobId))
}
