// Two customer records are the same person when they have the same phone and the same name.
// A household can share a phone, so the name tells its people apart. Case and extra spaces in
// the name don't count: 'maria  LOPEZ' is 'Maria Lopez'. The only definition: online booking
// and spreadsheet import both use it. `phone` is E.164 ('+16025550111').
export function customerMatchKey(phone: string, name: string): string {
  return `${phone}|${name.trim().replace(/\s+/g, ' ').toLowerCase()}`
}
