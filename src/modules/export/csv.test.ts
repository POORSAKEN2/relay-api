import { describe, expect, it } from 'vitest'
import { csvCell, csvRow } from './csv.ts'

describe('csvCell', () => {
  it('writes empty for null and undefined', () => {
    expect(csvCell(null)).toBe('')
    expect(csvCell(undefined)).toBe('')
  })

  it('writes dates as ISO text, numbers and booleans as they are', () => {
    expect(csvCell(new Date('2030-01-08T15:00:00Z'))).toBe('2030-01-08T15:00:00.000Z')
    expect(csvCell(8900)).toBe('8900')
    expect(csvCell(false)).toBe('false')
  })

  it('quotes cells with a comma, quote or line break', () => {
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('line 1\nline 2')).toBe('"line 1\nline 2"')
  })

  it('defuses text a spreadsheet would run as a formula', () => {
    expect(csvCell('=HYPERLINK("http://evil")')).toBe('"\'=HYPERLINK(""http://evil"")"')
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)")
    expect(csvCell('-2+3')).toBe("'-2+3")
    expect(csvCell('+cmd|calc')).toBe("'+cmd|calc")
  })

  it('leaves phone numbers and negative numbers alone', () => {
    expect(csvCell('+14805551234')).toBe('+14805551234')
    expect(csvCell('(480) 555-1234')).toBe('(480) 555-1234')
    expect(csvCell(-5)).toBe('-5')
  })
})

describe('csvRow', () => {
  it('joins cells with commas and ends the line with CRLF', () => {
    expect(csvRow(['Maria', null, 3])).toBe('Maria,,3\r\n')
  })
})
