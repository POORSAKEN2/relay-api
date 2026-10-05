import { formatDay, formatWindow } from '../../lib/labels.ts'

export type AssignmentChange = 'assigned' | 'changed' | 'removed'

const HEADLINES: Record<AssignmentChange, string> = {
  assigned: 'New job',
  changed: 'Job changed',
  removed: 'Job taken off your list',
}

// The technician's text about their assignment. `link` is null for "removed": the job
// isn't theirs anymore, so a link would only open the expired page.
export function assignmentText(
  change: AssignmentChange,
  job: {
    contractorName: string
    serviceName: string
    city: string
    date: string
    localStart: string
    localEnd: string
  },
  link: string | null,
): string {
  // A plain hyphen: an en dash would make the SMS cost 70 characters instead of 160.
  const when = `${formatDay(job.date)}, ${formatWindow(job.localStart, job.localEnd).replace('–', '-')}`
  const text = `${job.contractorName}: ${HEADLINES[change]}. ${job.serviceName} in ${job.city}, ${when}.`
  return link ? `${text} ${link}` : text
}
