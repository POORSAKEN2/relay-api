import { describe, expect, it } from 'vitest'
import { assignmentText } from './assignment-text.ts'

describe('assignmentText', () => {
  const sampleJob = {
    contractorName: 'Desert Breeze Air',
    serviceName: 'AC Tune-up',
    city: 'Palm Springs',
    date: '2030-01-08',
    localStart: '08:00:00',
    localEnd: '12:00:00',
  }
  const link = 'https://desert.example/j/abc'

  it('formats new job assignment text with link', () => {
    const text = assignmentText('assigned', sampleJob, link)
    expect(text).toBe(
      'Desert Breeze Air: New job. AC Tune-up in Palm Springs, Tue, Jan 8, 8 AM-12 PM. https://desert.example/j/abc',
    )
    expect(text).not.toContain('–')
  })

  it('formats job changed text with link', () => {
    const text = assignmentText('changed', sampleJob, link)
    expect(text).toBe(
      'Desert Breeze Air: Job changed. AC Tune-up in Palm Springs, Tue, Jan 8, 8 AM-12 PM. https://desert.example/j/abc',
    )
    expect(text).not.toContain('–')
  })

  it('formats job removed text without link', () => {
    const text = assignmentText('removed', sampleJob, null)
    expect(text).toBe(
      'Desert Breeze Air: Job taken off your list. AC Tune-up in Palm Springs, Tue, Jan 8, 8 AM-12 PM.',
    )
    expect(text).not.toContain('–')
  })
})
