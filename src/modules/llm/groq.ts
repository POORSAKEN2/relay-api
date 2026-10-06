import { z } from 'zod'
import { env } from '../../config/env.ts'
import {
  type ChatReply,
  type ChatRequest,
  DEFAULT_MAX_TOKENS,
  LlmUnavailable,
  type ToolCall,
} from './types.ts'

// Groq (https://groq.com): OpenAI-style chat completions over plain fetch. The only file that
// knows Groq's request and response shapes.

const CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions'

export async function chat(request: ChatRequest): Promise<ChatReply> {
  let res: Response
  try {
    res = await fetch(CHAT_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.GROQ_API_KEY ?? ''}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(toGroqBody(request, env.GROQ_MODEL)),
      signal: AbortSignal.timeout(env.LLM_TIMEOUT_MS),
    })
  } catch (error) {
    // Timed out, or the network failed.
    throw new LlmUnavailable(`Groq request failed: ${(error as Error).message}`)
  }
  if (!res.ok) {
    throw new LlmUnavailable(`Groq answered ${res.status}: ${(await res.text()).slice(0, 300)}`)
  }
  const parsed = GroqResponse.safeParse(await res.json())
  if (!parsed.success) throw new LlmUnavailable('Groq answered in an unexpected shape')
  return fromGroqResponse(parsed.data)
}

// Our request → Groq's body.
export function toGroqBody(request: ChatRequest, model: string) {
  const messages: Record<string, unknown>[] = [{ role: 'system', content: request.system }]
  for (const message of request.messages) {
    if (message.role === 'user') {
      messages.push({ role: 'user', content: message.text })
    } else if (message.role === 'assistant') {
      // An empty turn (no words, no tools) would be refused: it says nothing anyway.
      if (!message.text && message.toolCalls.length === 0) continue
      messages.push({
        role: 'assistant',
        content: message.text || null,
        ...(message.toolCalls.length > 0
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) },
              })),
            }
          : {}),
      })
    } else {
      for (const result of message.results) {
        messages.push({ role: 'tool', tool_call_id: result.toolCallId, content: result.output })
      }
    }
  }
  return {
    model,
    messages,
    // Reasoning models count their thinking here too.
    max_completion_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...(request.tools.length > 0
      ? {
          tools: request.tools.map((tool) => ({
            type: 'function',
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            },
          })),
        }
      : {}),
  }
}

const GroqResponse = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullish(),
          tool_calls: z
            .array(
              z.object({
                id: z.string(),
                function: z.object({ name: z.string(), arguments: z.string() }),
              }),
            )
            .nullish(),
        }),
      }),
    )
    .min(1),
  usage: z.object({ prompt_tokens: z.number(), completion_tokens: z.number() }).nullish(),
})
type GroqResponse = z.infer<typeof GroqResponse>

// Groq's response → our reply. An empty reply counts as the model being unavailable.
export function fromGroqResponse(response: GroqResponse): ChatReply {
  const { message } = response.choices[0]
  const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((call) => ({
    id: call.id,
    name: call.function.name,
    input: parseJson(call.function.arguments),
  }))
  const text = (message.content ?? '').trim()
  // Nothing to say and nothing to do: as good as no answer.
  if (!text && toolCalls.length === 0) throw new LlmUnavailable('Groq gave an empty reply')
  return {
    text,
    toolCalls,
    usage: {
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
    },
  }
}

// Tool arguments arrive as a JSON string. Bad JSON becomes null: the tool's own check then
// tells the model what was wrong, so it can try again.
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
