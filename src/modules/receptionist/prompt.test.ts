import { expect, it } from 'vitest'
import { buildSystemPrompt, CALL_CONSENT_QUESTION, greeting, spokenWindow } from './prompt.ts'

const input = {
  tenantName: 'Desert Breeze Air',
  today: 'Tuesday, January 8, 2030',
  services: [
    { key: 'S1', name: 'AC repair', feeLabel: '$89 diagnostic fee' },
    { key: 'S2', name: 'Furnace tune-up', feeLabel: '$129' },
  ],
  caller: null,
}

it('greets in the contractor’s name and discloses the AI and the recording', () => {
  const words = greeting('Desert Breeze Air')
  expect(words).toContain('Thanks for calling Desert Breeze Air')
  expect(words).toContain('AI')
  expect(words).toContain('recorded')
})

it('names the contractor, the date, the services by key and the consent question', () => {
  const prompt = buildSystemPrompt(input)
  expect(prompt).toContain('Desert Breeze Air')
  expect(prompt).toContain('Tuesday, January 8, 2030')
  expect(prompt).toContain('- S1: AC repair ($89 diagnostic fee)')
  expect(prompt).toContain('- S2: Furnace tune-up ($129)')
  expect(prompt).toContain(CALL_CONSENT_QUESTION)
  expect(prompt).toContain('not a known customer')
})

it('asks a returning caller about their saved address', () => {
  const prompt = buildSystemPrompt({
    ...input,
    caller: { name: 'Maria Lopez', addresses: ['12 Palm St, Phoenix'] },
  })
  expect(prompt).toContain('Maria Lopez')
  expect(prompt).toContain('Is this about 12 Palm St, Phoenix?')
})

it('never shows the model an id', () => {
  const prompt = buildSystemPrompt(input)
  expect(prompt).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/)
})

it('says an arrival window the way a person would', () => {
  expect(spokenWindow('2030-01-08', '08:00:00', '12:00:00')).toBe(
    'Tuesday, January 8, between 8 AM and 12 PM',
  )
  expect(spokenWindow('2030-01-09', '12:30:00', '16:00:00')).toBe(
    'Wednesday, January 9, between 12:30 PM and 4 PM',
  )
})
