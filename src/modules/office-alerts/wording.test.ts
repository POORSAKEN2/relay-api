import { describe, expect, it } from 'vitest'
import { JOB_SOURCES } from '../../db/schema.ts'
import { type AlertJobSummary, officeAlertText, SOURCE_LABELS } from './wording.ts'

const baseJob: AlertJobSummary = {
  contractorName: 'Desert Breeze Air',
  source: 'web',
  priority: false,
  vulnerableOccupant: false,
  serviceName: 'AC repair',
  city: 'Phoenix',
  date: '2030-01-08',
  localStart: '08:00:00',
  localEnd: '10:00:00',
}

const link = 'https://desert.localhost/dashboard?date=2030-01-08&job=123'

describe('officeAlertText', () => {
  it('formats an ordinary booking alert', () => {
    const text = officeAlertText(baseJob, link)
    expect(text).toBe(
      'Desert Breeze Air: New booking (online). AC repair in Phoenix, Tue, Jan 8, 8 AM-10 AM. https://desert.localhost/dashboard?date=2030-01-08&job=123',
    )
  })

  it('formats a priority alert for a vulnerable occupant', () => {
    const text = officeAlertText(
      { ...baseJob, priority: true, vulnerableOccupant: true, source: 'ai' },
      link,
    )
    expect(text).toBe(
      'Desert Breeze Air: PRIORITY job (by the AI receptionist). Vulnerable person, no heat or cooling. AC repair in Phoenix, Tue, Jan 8, 8 AM-10 AM. https://desert.localhost/dashboard?date=2030-01-08&job=123',
    )
  })

  it('formats a priority alert when priority fee was requested', () => {
    const text = officeAlertText(
      { ...baseJob, priority: true, vulnerableOccupant: false, source: 'office' },
      link,
    )
    expect(text).toBe(
      'Desert Breeze Air: PRIORITY job (by the office). Priority service requested. AC repair in Phoenix, Tue, Jan 8, 8 AM-10 AM. https://desert.localhost/dashboard?date=2030-01-08&job=123',
    )
  })

  it('has a label for every entry in JOB_SOURCES', () => {
    for (const source of JOB_SOURCES) {
      expect(SOURCE_LABELS[source]).toBeDefined()
      expect(typeof SOURCE_LABELS[source]).toBe('string')
    }
  })

  it('contains no curly apostrophes or en dashes in any body', () => {
    for (const source of JOB_SOURCES) {
      for (const priority of [true, false]) {
        for (const vulnerableOccupant of [true, false]) {
          const text = officeAlertText({ ...baseJob, source, priority, vulnerableOccupant }, link)
          expect(text).not.toContain('’')
          expect(text).not.toContain('–')
        }
      }
    }
  })
})
