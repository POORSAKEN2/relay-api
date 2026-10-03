import { describe, expect, it } from 'vitest'
import {
  ADDRESS_NOT_SPLIT,
  AGE_UNREADABLE,
  cleanZip,
  EXTRAS_NEED_ADDRESS,
  readImportRow,
  splitAddress,
  stateCode,
} from './import-rows.ts'

const today = new Date(2026, 9, 3)
const maria = { name: 'Maria', lastName: 'Lopez', phone: '(602) 555-0111' }
const palmSt = { street: '12 Palm St', city: 'Phoenix', state: 'AZ', zip: '85004' }
const read = (row: object, addressInOneColumn = false) =>
  readImportRow({ row: 2, ...row }, addressInOneColumn, today)

describe('readImportRow', () => {
  it('reads a contact-only row', () => {
    expect(
      read({
        name: '  Maria ',
        lastName: ' Lopez',
        phone: '602.555.0111',
        email: ' Maria@Example.com ',
      }),
    ).toEqual({
      ok: true,
      value: {
        customer: {
          name: 'Maria Lopez',
          phone: '+16025550111',
          email: 'maria@example.com',
          notes: null,
        },
        property: null,
      },
    })
  })

  it('removes extra spaces inside a name', () => {
    expect(read({ name: 'Maria   de  Lopez', phone: '6025550111' })).toMatchObject({
      ok: true,
      value: { customer: { name: 'Maria de Lopez' } },
    })
  })

  it('reads phones however they were typed or stored', () => {
    for (const phone of ['6025550111', '1-602-555-0111', '+1 (602) 555 0111', '16025550111']) {
      expect(read({ name: 'Maria', phone })).toMatchObject({
        ok: true,
        value: { customer: { phone: '+16025550111' } },
      })
    }
  })

  it('reads an address in separate columns, with a state name and a ZIP+4', () => {
    expect(
      read({
        ...maria,
        street: '12 Palm St',
        unit: '4',
        city: 'Phoenix',
        state: 'Arizona',
        zip: '85004-1234',
        equipmentBrand: 'Carrier',
        equipmentAge: '12',
        accessNotes: 'Gate 4411',
        notes: 'Pays by check',
      }),
    ).toEqual({
      ok: true,
      value: {
        customer: { name: 'Maria Lopez', phone: '+16025550111', notes: 'Pays by check' },
        property: {
          street: '12 Palm St',
          unit: '4',
          city: 'Phoenix',
          state: 'AZ',
          zip: '85004',
          equipmentBrand: 'Carrier',
          equipmentYear: 2014,
          notes: 'Gate 4411',
        },
      },
    })
  })

  it('reads an address in one column', () => {
    expect(
      read({ ...maria, address: '12 Palm St, Unit 4, Phoenix, AZ 85004' }, true),
    ).toMatchObject({
      ok: true,
      value: {
        property: {
          street: '12 Palm St',
          unit: 'Unit 4',
          city: 'Phoenix',
          state: 'AZ',
          zip: '85004',
        },
      },
    })
  })

  it('reads the equipment age, install year or a date', () => {
    const year = (equipmentAge: string) => {
      const result = read({ ...maria, ...palmSt, equipmentAge })
      return result.ok ? result.value.property?.equipmentYear : result.problems
    }
    expect(year('2014')).toBe(2014)
    expect(year('12')).toBe(2014)
    expect(year('12 years old')).toBe(2014)
    expect(year('0')).toBe(2026)
    expect(year('2014-05-01')).toBe(2014)
    expect(year('5/1/2014')).toBe(2014)
    expect(year('')).toBeNull()
    expect(year('unknown')).toEqual([AGE_UNREADABLE])
    expect(year('1949')).toEqual(['Check the equipment age'])
    expect(year('80')).toEqual(['Check the equipment age'])
  })

  it('lists every problem with the row', () => {
    expect(
      read({
        name: '',
        phone: '555',
        email: 'nope',
        street: '12 Palm St',
        city: '',
        state: 'Zona',
        zip: '850',
      }),
    ).toEqual({
      ok: false,
      problems: [
        'Enter the customer’s name',
        'Enter a mobile number, like 0917 123 4567',
        'Enter a valid email address',
        'Enter the city',
        'Enter a 2-letter state, like AZ',
        'Enter a 5-digit ZIP code',
      ],
    })
  })

  it('refuses equipment without an address, and an address it can’t split', () => {
    expect(read({ ...maria, equipmentBrand: 'Carrier' })).toEqual({
      ok: false,
      problems: [EXTRAS_NEED_ADDRESS],
    })
    expect(read({ ...maria, address: 'Phoenix AZ' }, true)).toEqual({
      ok: false,
      problems: [ADDRESS_NOT_SPLIT],
    })
  })

  it('refuses notes that are too long', () => {
    expect(read({ ...maria, notes: 'x'.repeat(2001) })).toEqual({
      ok: false,
      problems: ['Keep the notes under 2,000 characters'],
    })
  })
})

describe('splitAddress', () => {
  it('splits street, unit, city, state and ZIP', () => {
    expect(splitAddress('12 Palm St, Phoenix, AZ 85004')).toEqual({
      street: '12 Palm St',
      unit: '',
      city: 'Phoenix',
      state: 'AZ',
      zip: '85004',
    })
    expect(splitAddress('12 Palm St, Apt 4, Phoenix, AZ, 85004-1234')).toEqual({
      street: '12 Palm St',
      unit: 'Apt 4',
      city: 'Phoenix',
      state: 'AZ',
      zip: '85004-1234',
    })
    expect(splitAddress('12 Palm St, Santa Fe, New Mexico 87501')).toEqual({
      street: '12 Palm St',
      unit: '',
      city: 'Santa Fe',
      state: 'New Mexico',
      zip: '87501',
    })
    expect(splitAddress('')).toEqual({ street: '', unit: '', city: '', state: '', zip: '' })
  })

  it('gives up on what doesn’t fit', () => {
    expect(splitAddress('12 Palm St Phoenix AZ 85004')).toBeUndefined()
    expect(splitAddress('12 Palm St, Phoenix')).toBeUndefined()
    expect(splitAddress('1, 2, 3, 4, AZ 85004')).toBeUndefined()
  })
})

describe('stateCode and cleanZip', () => {
  it('turns state names into codes', () => {
    expect(stateCode('Arizona')).toBe('AZ')
    expect(stateCode('new  mexico')).toBe('NM')
    expect(stateCode('District of Columbia')).toBe('DC')
    expect(stateCode('az')).toBe('az') // the state rule upper-cases codes itself
    expect(stateCode('Narnia')).toBe('Narnia')
  })

  it('cleans ZIP codes', () => {
    expect(cleanZip('85004-1234')).toBe('85004')
    expect(cleanZip('2134')).toBe('02134')
    expect(cleanZip('85004')).toBe('85004')
  })
})
