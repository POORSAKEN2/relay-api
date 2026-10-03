import type { z } from 'zod'
import { CustomerNotes, NewCustomer, PropertyInput } from './customers.schemas.ts'
import type { ImportRow } from './imports.schemas.ts'

// Turning one spreadsheet row into a customer and an address, or into the reasons it can't be
// imported. Pure: no database. The contact and address rules are the customer screens' own
// (customers.schemas.ts); only the spreadsheet-specific reading lives here.

export const ADDRESS_NOT_SPLIT = 'Couldn’t split the address. Write it as street, city, ST ZIP'
export const AGE_UNREADABLE = 'Couldn’t read the equipment age or install year'
export const EXTRAS_NEED_ADDRESS = 'Equipment and access notes need an address'

export type ImportedCustomer = {
  name: string
  phone: string
  email?: string
  notes: string | null
}

export type ImportedProperty = {
  street: string
  unit: string | null
  city: string
  state: string
  zip: string
  equipmentBrand: string | null
  equipmentYear: number | null
  notes: string | null // access notes
}

export type ReadyRow = { customer: ImportedCustomer; property: ImportedProperty | null }
export type RowReading = { ok: true; value: ReadyRow } | { ok: false; problems: string[] }

type Address = { street: string; unit: string; city: string; state: string; zip: string }

export function readImportRow(
  row: ImportRow,
  addressInOneColumn: boolean,
  today = new Date(),
): RowReading {
  const problems: string[] = []
  const name = [text(row.name), text(row.lastName)].filter(Boolean).join(' ')
  const contact = NewCustomer.safeParse({ name, phone: text(row.phone), email: text(row.email) })
  if (!contact.success) problems.push(...messages(contact.error))
  const notes = CustomerNotes.safeParse(text(row.notes))
  if (!notes.success) problems.push(...messages(notes.error))
  const property = readProperty(row, addressInOneColumn, today, problems)
  if (!contact.success || !notes.success || problems.length > 0) return { ok: false, problems }
  return {
    ok: true,
    value: { customer: { ...contact.data, notes: notes.data ?? null }, property },
  }
}

// The address with its equipment and access notes, or null when the row has no address.
// Adds to `problems` when something can't be read.
function readProperty(
  row: ImportRow,
  addressInOneColumn: boolean,
  today: Date,
  problems: string[],
): ImportedProperty | null {
  const address: Address | undefined = addressInOneColumn
    ? splitAddress(text(row.address))
    : {
        street: text(row.street),
        unit: text(row.unit),
        city: text(row.city),
        state: text(row.state),
        zip: text(row.zip),
      }
  if (!address) {
    problems.push(ADDRESS_NOT_SPLIT)
    return null
  }
  const brand = text(row.equipmentBrand)
  const age = text(row.equipmentAge)
  const accessNotes = text(row.accessNotes)
  if (!Object.values(address).some(Boolean)) {
    if (brand || age || accessNotes) problems.push(EXTRAS_NEED_ADDRESS)
    return null
  }
  const equipmentYear = readInstallYear(age, today)
  if (equipmentYear === undefined) problems.push(AGE_UNREADABLE)
  const parsed = PropertyInput.safeParse({
    street: address.street,
    unit: address.unit || undefined,
    city: address.city,
    state: stateCode(address.state),
    zip: cleanZip(address.zip),
    equipmentBrand: brand,
    equipmentYear: equipmentYear ?? null,
    notes: accessNotes,
  })
  if (!parsed.success) {
    problems.push(...messages(parsed.error))
    return null
  }
  const value = parsed.data
  return {
    street: value.street,
    unit: value.unit || null,
    city: value.city,
    state: value.state,
    zip: value.zip,
    equipmentBrand: value.equipmentBrand ?? null,
    equipmentYear: value.equipmentYear ?? null,
    notes: value.notes ?? null,
  }
}

// '12 Palm St, Unit 4, Phoenix, AZ 85004' → its parts. The state and ZIP may share the last
// part or be two parts. A blank value is a blank address; anything else that doesn't fit is
// undefined.
export function splitAddress(value: string): Address | undefined {
  if (value === '') return { street: '', unit: '', city: '', state: '', zip: '' }
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
  const tail = stateAndZipOf(parts)
  if (!tail) return undefined
  const [street = '', second = '', third = ''] = tail.rest
  if (tail.rest.length === 2) {
    return { street, unit: '', city: second, state: tail.state, zip: tail.zip }
  }
  if (tail.rest.length === 3) {
    return { street, unit: second, city: third, state: tail.state, zip: tail.zip }
  }
  return undefined
}

// The state and ZIP at the end of an address, and the parts before them.
function stateAndZipOf(parts: string[]) {
  const last = parts[parts.length - 1] ?? ''
  const together = /^(.+?)\s+(\d{5}(?:-\d{4})?)$/.exec(last)
  if (together) {
    return { state: together[1] ?? '', zip: together[2] ?? '', rest: parts.slice(0, -1) }
  }
  if (/^\d{5}(?:-\d{4})?$/.test(last) && parts.length >= 4) {
    return { state: parts[parts.length - 2] ?? '', zip: last, rest: parts.slice(0, -2) }
  }
  return undefined
}

// 'Arizona' → 'AZ'. Anything else comes back as typed, for the state rule to judge.
export function stateCode(value: string): string {
  return STATE_CODES[value.toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim()] ?? value
}

// '85004-1234' → '85004'; '2134' (Excel dropped the leading 0) → '02134'.
export function cleanZip(value: string): string {
  const zipPlusFour = /^(\d{5})-\d{4}$/.exec(value)
  if (zipPlusFour) return zipPlusFour[1] ?? value
  if (/^\d{4}$/.test(value)) return `0${value}`
  return value
}

// The install year from what the sheet says: a year ('2014'), an age ('12', '12 years old'),
// or a date ('2014-05-01', '5/1/2014'). Blank is null; anything else is undefined. Whether the
// year is plausible is the address rule's call (PropertyInput).
function readInstallYear(value: string, today: Date): number | null | undefined {
  if (value === '') return null
  if (/^\d{4}$/.test(value)) return Number(value)
  const age = /^(\d{1,3})\s*(?:years?|yrs?)?(?:\s*old)?$/i.exec(value)
  if (age) return today.getFullYear() - Number(age[1])
  const date = /^(\d{4})-\d{1,2}-\d{1,2}$/.exec(value) ?? /^\d{1,2}\/\d{1,2}\/(\d{4})$/.exec(value)
  if (date) return Number(date[1])
  return undefined
}

function text(value: string | undefined): string {
  return (value ?? '').trim()
}

function messages(error: z.ZodError): string[] {
  return [...new Set(error.issues.map((issue) => issue.message))]
}

const STATE_CODES: Record<string, string> = {
  alabama: 'AL',
  alaska: 'AK',
  arizona: 'AZ',
  arkansas: 'AR',
  california: 'CA',
  colorado: 'CO',
  connecticut: 'CT',
  delaware: 'DE',
  'district of columbia': 'DC',
  florida: 'FL',
  georgia: 'GA',
  hawaii: 'HI',
  idaho: 'ID',
  illinois: 'IL',
  indiana: 'IN',
  iowa: 'IA',
  kansas: 'KS',
  kentucky: 'KY',
  louisiana: 'LA',
  maine: 'ME',
  maryland: 'MD',
  massachusetts: 'MA',
  michigan: 'MI',
  minnesota: 'MN',
  mississippi: 'MS',
  missouri: 'MO',
  montana: 'MT',
  nebraska: 'NE',
  nevada: 'NV',
  'new hampshire': 'NH',
  'new jersey': 'NJ',
  'new mexico': 'NM',
  'new york': 'NY',
  'north carolina': 'NC',
  'north dakota': 'ND',
  ohio: 'OH',
  oklahoma: 'OK',
  oregon: 'OR',
  pennsylvania: 'PA',
  'rhode island': 'RI',
  'south carolina': 'SC',
  'south dakota': 'SD',
  tennessee: 'TN',
  texas: 'TX',
  utah: 'UT',
  vermont: 'VT',
  virginia: 'VA',
  washington: 'WA',
  'west virginia': 'WV',
  wisconsin: 'WI',
  wyoming: 'WY',
}
