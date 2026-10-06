import { afterEach, expect, it, vi } from 'vitest'
import { env } from '../../config/env.ts'
import * as anthropic from './anthropic.ts'
import * as groq from './groq.ts'
import { chat, LlmUnavailable } from './llm.ts'

vi.mock('./groq.ts', () => ({ chat: vi.fn() }))
vi.mock('./anthropic.ts', () => ({ chat: vi.fn() }))

const request = { system: 's', messages: [{ role: 'user' as const, text: 'hi' }], tools: [] }
const reply = { text: 'Hello', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } }

afterEach(() => {
  env.LLM_PROVIDER = 'off'
  vi.mocked(groq.chat).mockReset()
  vi.mocked(anthropic.chat).mockReset()
})

it('answers nothing when switched off', async () => {
  env.LLM_PROVIDER = 'off'
  await expect(chat(request)).rejects.toBeInstanceOf(LlmUnavailable)
})

it('asks the provider LLM_PROVIDER names', async () => {
  vi.mocked(groq.chat).mockResolvedValue(reply)
  vi.mocked(anthropic.chat).mockResolvedValue({ ...reply, text: 'From Claude' })

  env.LLM_PROVIDER = 'groq'
  expect(await chat(request)).toEqual(reply)
  env.LLM_PROVIDER = 'anthropic'
  expect((await chat(request)).text).toBe('From Claude')

  expect(groq.chat).toHaveBeenCalledTimes(1)
  expect(anthropic.chat).toHaveBeenCalledTimes(1)
})
