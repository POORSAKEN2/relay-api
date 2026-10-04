import { type Db, db, type Tx } from '../../db/client.ts'
import type { PRICE_TYPES } from '../../db/schema.ts'
import { HttpError } from '../../lib/http-error.ts'
import { emitToTenant } from '../../realtime/index.ts'
import * as audit from '../audit/audit.queries.ts'
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

type Actor = { tenantId: string; userId: string }
type CheckJob = (job: { technicianId: string | null }) => void

// One change to a job's repairs: only while the job is in progress, recorded in the audit log
// with what changed, and announced so open screens reload. `checkJob` runs on the locked job
// first (the technician side checks the job is still theirs).
async function changeRepairs(
  actor: Actor,
  jobId: string,
  checkJob: CheckJob | undefined,
  change: (tx: Tx) => Promise<{ action: string; data: Record<string, unknown> }>,
) {
  const date = await db.transaction(async (tx) => {
    const job = await queries.lockJob(actor.tenantId, jobId, tx)
    if (!job) throw new HttpError(404, 'not_found', 'This job isn’t on the board anymore.')
    checkJob?.(job)
    if (job.status !== 'in_progress') {
      throw new HttpError(422, 'invalid_transition', 'Start the job before adding repairs.')
    }
    const { action, data } = await change(tx)
    await audit.insertUserAction(
      actor.tenantId,
      { actorUserId: actor.userId, action, entityType: 'job', entityId: jobId, data },
      tx,
    )
    return job.date
  })
  emitToTenant(actor.tenantId, 'job.charges_changed', { jobId, dates: [date] })
}

// A repair from the price list, at its listed price, waiting for the homeowner.
export function proposeRepair(
  actor: Actor,
  jobId: string,
  input: { priceItemId: string; quantity: number },
  checkJob?: CheckJob,
) {
  return changeRepairs(actor, jobId, checkJob, async (tx) => {
    const price = await queries.findActivePriceItem(actor.tenantId, input.priceItemId, tx)
    if (!price) {
      throw new HttpError(422, 'not_on_list', 'That price isn’t on the list anymore.')
    }
    const [line] = await queries.insertLines(
      actor.tenantId,
      [
        {
          jobId,
          priceItemId: input.priceItemId,
          description: price.name,
          quantity: input.quantity,
          unitPriceCents: price.priceCents,
          status: 'proposed',
          createdBy: actor.userId,
        },
      ],
      tx,
    )
    return {
      action: 'job.repair_proposed',
      data: {
        itemId: line.id,
        description: price.name,
        quantity: input.quantity,
        unitPriceCents: price.priceCents,
      },
    }
  })
}

export function removeRepair(actor: Actor, jobId: string, itemId: string, checkJob?: CheckJob) {
  return changeRepairs(actor, jobId, checkJob, async (tx) => {
    const line = await queries.findLine(actor.tenantId, jobId, itemId, tx)
    if (!line) throw new HttpError(404, 'not_found', 'That repair isn’t on this job.')
    if (line.status !== 'proposed') {
      throw new HttpError(422, 'locked', 'Only repairs waiting for the homeowner can be removed.')
    }
    await queries.deleteLine(actor.tenantId, itemId, tx)
    return { action: 'job.repair_removed', data: { itemId } }
  })
}

// The homeowner's answer, given in person on the technician's phone, for every waiting repair.
export function decideRepairs(
  actor: Actor,
  jobId: string,
  decision: 'approved' | 'declined',
  checkJob?: CheckJob,
) {
  return changeRepairs(actor, jobId, checkJob, async (tx) => {
    const decided = await queries.decideProposed(actor.tenantId, jobId, decision, tx)
    if (decided.length === 0) {
      throw new HttpError(
        422,
        'nothing_to_decide',
        'There are no repairs waiting for the homeowner.',
      )
    }
    return {
      action: decision === 'approved' ? 'job.repairs_approved' : 'job.repairs_declined',
      data: {
        itemIds: decided.map((line) => line.id),
        totalCents: decided.reduce((total, line) => total + line.quantity * line.unitPriceCents, 0),
        how: 'in_person',
      },
    }
  })
}
