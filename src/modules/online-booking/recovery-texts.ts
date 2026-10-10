// The next-morning texts that bring a lead back: a homeowner who stopped partway through
// booking, and a caller nobody answered. Plain ASCII (no en dash, no curly quote), so a text
// stays in the cheaper SMS encoding.

type RecoveryText = {
  tenantName: string
  windows: string[] // 'Tue, Oct 13 8 AM - 12 PM', soonest first; may be empty
  link: string
}

export function abandonedBookingText(text: RecoveryText) {
  return `${text.tenantName}: you started booking a visit.${openTimes(text.windows)} Finish here: ${text.link} Reply STOP to opt out.`
}

export function missedCallerReminderText(text: RecoveryText) {
  return `${text.tenantName}: still need a visit? Sorry we missed your call.${openTimes(text.windows)} Book here: ${text.link} Reply STOP to opt out.`
}

// Left out when nothing is open: the link still shows the calendar.
function openTimes(windows: string[]) {
  return windows.length > 0 ? ` Open times: ${windows.join('; ')}.` : ''
}
