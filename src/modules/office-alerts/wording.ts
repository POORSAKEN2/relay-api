import type { JobSource } from '../../db/schema.ts'
import { formatDay, formatWindow } from '../../lib/labels.ts'

// Labels shown to staff for how a booking came in.
export const SOURCE_LABELS: Record<JobSource, string> = {
  web: 'online',
  office: 'by the office',
  ai: 'by the AI receptionist',
  text_back: 'from a text-back',
  recovery_text: 'from a recovery text',
}

export type AlertJobSummary = {
  contractorName: string
  source: JobSource
  priority: boolean
  vulnerableOccupant: boolean
  serviceName: string
  city: string
  date: string // local day, '2030-01-08'
  localStart: string // '08:00:00'
  localEnd: string // '10:00:00'
}

// Plain GSM-7 characters only (' and -, never curly apostrophes or en dashes).
export function officeAlertText(job: AlertJobSummary, link: string): string {
  const when = `${formatDay(job.date)}, ${formatWindow(job.localStart, job.localEnd).replace('–', '-')}`
  const source = SOURCE_LABELS[job.source]

  if (job.priority) {
    const reason = job.vulnerableOccupant
      ? 'Vulnerable person, no heat or cooling.'
      : 'Priority service requested.'
    return `${job.contractorName}: PRIORITY job (${source}). ${reason} ${job.serviceName} in ${job.city}, ${when}. ${link}`
  }

  return `${job.contractorName}: New booking (${source}). ${job.serviceName} in ${job.city}, ${when}. ${link}`
}
