// Who takes a call the AI hands over, or null when nobody can. "Business hours" are today's
// arrival windows, from the first start to the last end, in the contractor's time zone:
// the office during hours, the on-call phone after, and the other one when only one is set.
export function transferTarget(
  phones: { officePhone: string | null; onCallPhone: string | null },
  todaysWindows: { startsAt: string; endsAt: string }[], // '08:00:00'
  localTime: string, // '14:05:00'
): string | null {
  const starts = todaysWindows.map((window) => window.startsAt).sort()
  const ends = todaysWindows.map((window) => window.endsAt).sort()
  // Times as 'HH:MM:SS' sort and compare correctly as plain strings.
  const duringHours =
    starts.length > 0 && localTime >= starts[0] && localTime < ends[ends.length - 1]
  return duringHours
    ? (phones.officePhone ?? phones.onCallPhone)
    : (phones.onCallPhone ?? phones.officePhone)
}
