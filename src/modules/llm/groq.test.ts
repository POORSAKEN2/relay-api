import { expect, it } from 'vitest'
import { fromGroqResponse, toGroqBody } from './groq.ts'
import { type ChatRequest, LlmUnavailable } from './types.ts'

const request: ChatRequest = {
  system: 'You answer the phone.',
  tools: [
    {
      name: 'check_service_area',
      description: 'Checks a ZIP code',
      parameters: { type: 'object', properties: { zip: { type: 'string' } }, required: ['zip'] },
    },
  ],
  messages: [
    { role: 'user', text: 'Do you come to 85004?' },
    {
      role: 'assistant',
      text: '',
      toolCalls: [{ id: 'call_1', name: 'check_service_area', input: { zip: '85004' } }],
    },
    {
      role: 'tool',
      results: [{ toolCallId: 'call_1', name: 'check_service_area', output: '{"served":true}' }],
    },
    { role: 'assistant', text: '', toolCalls: [] }, // empty: left out
    { role: 'assistant', text: 'Yes, we do.', toolCalls: [] },
  ],
}

it('turns our request into a chat completions body', () => {
  expect(toGroqBody(request, 'openai/gpt-oss-20b')).toEqual({
    model: 'openai/gpt-oss-20b',
    max_completion_tokens: 1024,
    messages: [
      { role: 'system', content: 'You answer the phone.' },
      { role: 'user', content: 'Do you come to 85004?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'check_service_area', arguments: '{"zip":"85004"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"served":true}' },
      { role: 'assistant', content: 'Yes, we do.' },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'check_service_area',
          description: 'Checks a ZIP code',
          parameters: request.tools[0].parameters,
        },
      },
    ],
  })
})

it('leaves tools out when there are none, and passes max tokens on', () => {
  const body = toGroqBody({ ...request, tools: [], maxTokens: 200 }, 'm')
  expect(body).not.toHaveProperty('tools')
  expect(body.max_completion_tokens).toBe(200)
})

it('reads a reply with text and tool calls', () => {
  const reply = fromGroqResponse({
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            { id: 'call_2', function: { name: 'get_open_windows', arguments: '{}' } },
            { id: 'call_3', function: { name: 'check_service_area', arguments: '{"zip": ' } },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 120, completion_tokens: 15 },
  })
  expect(reply).toEqual({
    text: '',
    toolCalls: [
      { id: 'call_2', name: 'get_open_windows', input: {} },
      // Bad JSON: passed on as null for the tool's check to refuse.
      { id: 'call_3', name: 'check_service_area', input: null },
    ],
    usage: { inputTokens: 120, outputTokens: 15 },
  })
})

it('reads a plain text reply', () => {
  const reply = fromGroqResponse({ choices: [{ message: { content: 'Hello!' } }] })
  expect(reply).toEqual({
    text: 'Hello!',
    toolCalls: [],
    usage: { inputTokens: 0, outputTokens: 0 },
  })
})

it('treats an empty reply as no answer', () => {
  expect(() => fromGroqResponse({ choices: [{ message: { content: '  ' } }] })).toThrow(
    LlmUnavailable,
  )
})
