// A value that is a plain number or phone number, like "+14805551234" or "(480) 555-1234".
const PHONE_OR_NUMBER = /^[+-]?[\d\s().-]+$/

function cellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

// One CSV cell. Quoted when it holds a comma, quote or line break.
// A text that starts with = + - @ is a formula in Excel and Sheets, and homeowners type the
// names and problems in this export, so those get a leading ' (phone numbers and numbers don't).
export function csvCell(value: unknown): string {
  let text = cellText(value)
  const first = text[0]
  const isFormula =
    first === '=' ||
    first === '@' ||
    first === '\t' ||
    first === '\r' ||
    ((first === '+' || first === '-') && !PHONE_OR_NUMBER.test(text))
  if (typeof value === 'string' && isFormula) text = `'${text}`
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

// A line of CSV, ending in CRLF.
export function csvRow(values: unknown[]): string {
  return `${values.map(csvCell).join(',')}\r\n`
}
