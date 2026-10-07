import { expect, it } from 'vitest'
import { mentionsGasOrCo } from './safety.ts'

it.each([
  'I smell gas in the kitchen',
  'It smells like gas',
  'There is a gas smell by the stove',
  'I think we have a gas leak',
  'Something smells like rotten eggs',
  'Our carbon monoxide detector is beeping',
  'The CO alarm keeps going off',
  'my c o detector is chirping',
  'CO-alarm!',
  'my co detectors went off',
])('catches "%s"', (text) => {
  expect(mentionsGasOrCo(text)).toBe(true)
})

it.each([
  'My gas furnace won’t start',
  'The gas heater is making a noise',
  'My AC stopped blowing cold air',
  'Can someone come to Colorado Street?',
  'The company called me back',
  '',
])('lets "%s" through', (text) => {
  expect(mentionsGasOrCo(text)).toBe(false)
})
