import type { Tx } from '../../db/client.ts'
import { formatDay, formatWindow } from '../../lib/labels.ts'
import { tenantUrl } from '../../lib/tenant-url.ts'
import { sendText } from '../messaging/sms.ts'
import * as queries from './dispatch.queries.ts'

// Saves a text to the technician about one of their jobs, in the caller's transaction: new,
// changed (with a link to the job page; the page needs them signed in, and the sign-in page
// sends them on to the job afterwards), or cancelled (no link: the job is gone from their
// list). Used by the office's moves and the homeowner's manage link. A technician without a
// phone gets none; the change stands.
export async function textTechnician(
  tenantId: string,
  jobId: string,
  technicianId: string,
  what: 'assigned' | 'changed' | 'cancelled',
  tx: Tx,
) {
  const job = await queries.findAssignmentText(tenantId, jobId, technicianId, tx)
  if (!job?.technicianPhone) return
  // A plain hyphen: an en dash would make the SMS cost 70 characters instead of 160.
  const when = `${formatDay(job.date)}, ${formatWindow(job.localStart, job.localEnd).replace('–', '-')}`
  const about = `${job.serviceName} in ${job.city}, ${when}.`
  const body =
    what === 'cancelled'
      ? `${job.contractorName}: Job cancelled. ${about}`
      : `${job.contractorName}: ${what === 'assigned' ? 'New job' : 'Job changed'}. ${about} ${tenantUrl(job.tenant, `/jobs/${jobId}`)}`
  await sendText(
    tenantId,
    { contact: job.technicianPhone, kind: 'job_assigned', body, toUserId: technicianId, jobId },
    tx,
  )
}
