// A job changed. `dates` are the local days whose board must refresh: two when a job moves.
type JobChange = { jobId: string; dates: string[] }

// Events the API sends to the browser, with their payloads.
export type RealtimeEvents = {
  'branding.updated': { tenantId: string }
  'booking.created': JobChange
  'booking.priority': JobChange
  'job.assigned': JobChange
  'job.status_changed': JobChange
  // A repair was added, removed, approved or declined on the job.
  'job.charges_changed': JobChange
  // A note was added to the job.
  'job.note_added': JobChange
  // A technician was added, edited, deactivated or reactivated.
  'team.updated': { tenantId: string }
  // A service was added, edited, archived, restored or moved in the list.
  'services.updated': { tenantId: string }
  // A homeowner texted in: the inbox refreshes that thread and the unread count.
  'inbox.updated': { contact: string }
}
