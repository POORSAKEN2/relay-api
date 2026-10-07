import type { Tx } from '../../db/client.ts'
import { tenantUrl } from '../../lib/tenant-url.ts'
import { sendText } from '../messaging/sms.ts'
import { type AssignmentChange, assignmentText } from './assignment-text.ts'
import * as queries from './dispatch.queries.ts'

// Saves a text to the technician about one of their jobs, with an expiring link to it, in the
// caller's transaction. Used by the office's moves and the homeowner's manage link. The link
// opens /j/:token, which needs the technician signed in; the sign-in page sends them on to the
// job afterwards. No link when the job is gone from their list (removed, cancelled). A
// technician without a phone gets nothing and the change stands.
export async function textTechnician(
  tenantId: string,
  jobId: string,
  technicianId: string,
  change: AssignmentChange,
  linkToken: string | null,
  tx: Tx,
) {
  const job = await queries.findAssignmentText(tenantId, jobId, technicianId, tx)
  if (!job?.technicianPhone) return
  const link = linkToken ? tenantUrl(job.tenant, `/j/${linkToken}`) : null
  const body = assignmentText(change, job, link)
  await sendText(
    tenantId,
    {
      contact: job.technicianPhone,
      kind: 'job_assigned',
      body,
      toUserId: technicianId,
      jobId,
    },
    tx,
  )
}
