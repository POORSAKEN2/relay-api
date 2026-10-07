import { expect, it } from 'vitest'
import { formatTranscript } from './transcript.ts'

it('writes one line per turn, naming who spoke', () => {
  expect(
    formatTranscript([
      { speaker: 'ai', text: 'Thanks for calling. How can I help you today?' },
      { speaker: 'caller', text: 'My AC stopped blowing cold air.' },
      { speaker: 'ai', text: 'Sorry to hear that. What’s the ZIP code there?' },
    ]),
  ).toBe(
    'AI: Thanks for calling. How can I help you today?\nCaller: My AC stopped blowing cold air.\nAI: Sorry to hear that. What’s the ZIP code there?',
  )
})

it('gives an empty transcript for no turns', () => {
  expect(formatTranscript([])).toBe('')
})
