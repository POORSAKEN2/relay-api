import Anthropic from '@anthropic-ai/sdk'
import { env } from '../../config/env.ts'
import {
  type ChatReply,
  type ChatRequest,
  DEFAULT_MAX_TOKENS,
  LlmUnavailable,
  type ToolCall,
} from './types.ts'

// Claude (Haiku 4.5 by default) through Anthropic's official SDK. The only file that knows
// Anthropic's request and response shapes.

let client: Anthropic | undefined

export async function chat(request: ChatRequest): Promise<ChatReply> {
  // Made on first use, so the app starts without a key when another provider is chosen.
  // No retries: a caller is waiting on the line, and the engine has its own fallback.
  client ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 0 })
  let message: Anthropic.Message
  try {
    message = await client.messages.create(toAnthropicParams(request, env.ANTHROPIC_MODEL), {
      timeout: env.LLM_TIMEOUT_MS,
    })
  } catch (error) {
    // Every SDK failure (rate limit, server error, timeout, network) is an APIError.
    if (error instanceof Anthropic.APIError) {
      throw new LlmUnavailable(`Anthropic request failed: ${error.message}`)
    }
    throw error
  }
  return fromAnthropicMessage(message)
}

// Our request → the SDK's parameters.
export function toAnthropicParams(
  request: ChatRequest,
  model: string,
): Anthropic.MessageCreateParamsNonStreaming {
  const messages: Anthropic.MessageParam[] = []
  for (const message of request.messages) {
    if (message.role === 'user') {
      messages.push({ role: 'user', content: message.text })
    } else if (message.role === 'assistant') {
      const content: Anthropic.ContentBlockParam[] = []
      if (message.text) content.push({ type: 'text', text: message.text })
      for (const call of message.toolCalls) {
        content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input ?? {} })
      }
      // An empty turn (no words, no tools) would be refused: it says nothing anyway.
      if (content.length > 0) messages.push({ role: 'assistant', content })
    } else {
      // All of a turn's tool results go back in one user message.
      messages.push({
        role: 'user',
        content: message.results.map((result) => ({
          type: 'tool_result' as const,
          tool_use_id: result.toolCallId,
          content: result.output,
        })),
      })
    }
  }

  return {
    model,
    max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
    system: request.system,
    messages,
    ...(request.tools.length > 0
      ? {
          tools: request.tools.map(
            (tool): Anthropic.Tool => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.parameters,
            }),
          ),
        }
      : {}),
  }
}

// The SDK's message → our reply. A reply with nothing usable (refused, or cut off before a
// word or a tool call) counts as the model being unavailable.
export function fromAnthropicMessage(message: Anthropic.Message): ChatReply {
  const texts: string[] = []
  const toolCalls: ToolCall[] = []
  for (const block of message.content) {
    if (block.type === 'text') texts.push(block.text)
    else if (block.type === 'tool_use') {
      toolCalls.push({ id: block.id, name: block.name, input: block.input })
    }
  }
  const text = texts.join('\n').trim()
  if (message.stop_reason === 'refusal' || (!text && toolCalls.length === 0)) {
    throw new LlmUnavailable(`Anthropic gave no usable reply (${message.stop_reason})`)
  }
  return {
    text,
    toolCalls,
    usage: {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
    },
  }
}
