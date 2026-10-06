import type Anthropic from '@anthropic-ai/sdk'
import { expect, it } from 'vitest'
import { fromAnthropicMessage, toAnthropicParams } from './anthropic.ts'
import { type ChatRequest, LlmUnavailable } from './types.ts'

const parameters = {
  type: 'object' as const,
  properties: { zip: { type: 'string' } },
  required: ['zip'],
}

const request: ChatRequest = {
  system: 'You answer the phone.',
  tools: [{ name: 'check_service_area', description: 'Checks a ZIP code', parameters }],
  messages: [
    { role: 'user', text: 'Do you come to 85004?' },
    {
      role: 'assistant',
      text: 'Let me check.',
      toolCalls: [
        { id: 'toolu_1', name: 'check_service_area', input: { zip: '85004' } },
        { id: 'toolu_2', name: 'get_open_windows', input: {} },
      ],
    },
    {
      role: 'tool',
      results: [
        { toolCallId: 'toolu_1', name: 'check_service_area', output: '{"served":true}' },
        { toolCallId: 'toolu_2', name: 'get_open_windows', output: '{"windows":[]}' },
      ],
    },
    { role: 'assistant', text: '', toolCalls: [] }, // empty: left out
  ],
}

it('turns our request into Messages API parameters', () => {
  expect(toAnthropicParams(request, 'claude-haiku-4-5')).toEqual({
    model: 'claude-haiku-4-5',
    max_tokens: 1024,
    system: 'You answer the phone.',
    tools: [
      { name: 'check_service_area', description: 'Checks a ZIP code', input_schema: parameters },
    ],
    messages: [
      { role: 'user', content: 'Do you come to 85004?' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check.' },
          { type: 'tool_use', id: 'toolu_1', name: 'check_service_area', input: { zip: '85004' } },
          { type: 'tool_use', id: 'toolu_2', name: 'get_open_windows', input: {} },
        ],
      },
      // Both results of the turn in one user message.
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: '{"served":true}' },
          { type: 'tool_result', tool_use_id: 'toolu_2', content: '{"windows":[]}' },
        ],
      },
    ],
  })
})

it('leaves tools out when there are none', () => {
  const params = toAnthropicParams({ ...request, tools: [], maxTokens: 200 }, 'm')
  expect(params).not.toHaveProperty('tools')
  expect(params.max_tokens).toBe(200)
})

// Only the fields the mapping reads; the SDK's type has many more.
function message(
  content: unknown[],
  stopReason: Anthropic.StopReason = 'end_turn',
): Anthropic.Message {
  return {
    content,
    stop_reason: stopReason,
    usage: { input_tokens: 300, output_tokens: 20 },
  } as unknown as Anthropic.Message
}

it('reads text and tool calls from a reply', () => {
  const reply = fromAnthropicMessage(
    message(
      [
        { type: 'text', text: 'Checking that ZIP code.' },
        { type: 'tool_use', id: 'toolu_3', name: 'check_service_area', input: { zip: '85201' } },
      ],
      'tool_use',
    ),
  )
  expect(reply).toEqual({
    text: 'Checking that ZIP code.',
    toolCalls: [{ id: 'toolu_3', name: 'check_service_area', input: { zip: '85201' } }],
    usage: { inputTokens: 300, outputTokens: 20 },
  })
})

it('treats a refusal or an empty cut-off reply as no answer', () => {
  expect(() => fromAnthropicMessage(message([{ type: 'text', text: 'No.' }], 'refusal'))).toThrow(
    LlmUnavailable,
  )
  expect(() => fromAnthropicMessage(message([], 'max_tokens'))).toThrow(LlmUnavailable)
})
