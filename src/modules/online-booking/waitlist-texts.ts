import { WAITLIST_OFFER_MINUTES } from '../../db/schema.ts'

// The texts a homeowner on the waitlist gets. Plain ASCII (no en dash, no curly quote), so a
// text stays in the cheaper SMS encoding.

export function offerText(offer: {
  tenantName: string
  dayLabel: string // 'Tue, Oct 7'
  windowLabel: string // '8 AM - 12 PM', from textWindow
  link: string
}) {
  return `${offer.tenantName}: a time opened up: ${offer.dayLabel}, ${offer.windowLabel}. It's yours for ${WAITLIST_OFFER_MINUTES} minutes: ${offer.link} Reply STOP to opt out.`
}

// After the last offer ran out.
export function takenOffText(notice: { tenantName: string; link: string }) {
  return `${notice.tenantName}: we've taken you off the waitlist. Book anytime: ${notice.link} Reply STOP to opt out.`
}
