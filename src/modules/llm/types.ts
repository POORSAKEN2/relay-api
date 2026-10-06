// The language model's request and reply, in Relay's own words. The receptionist works only
// with these; each provider file (groq.ts, anthropic.ts) translates them to its own shapes.

// A tool's input as JSON Schema: an object with named properties.
export type JsonSchemaObject = {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
}

export type ToolSpec = { name: string; description: string; parameters: JsonSchemaObject }

// `input` is whatever the model sent: the tool checks it (null when it wasn't valid JSON).
export type ToolCall = { id: string; name: string; input: unknown }

export type ChatMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls: ToolCall[] }
  // Every tool result of one turn travels together, as both providers want them.
  | { role: 'tool'; results: { toolCallId: string; name: string; output: string }[] }

export type ChatRequest = {
  system: string
  messages: ChatMessage[]
  tools: ToolSpec[]
  maxTokens?: number
}

export type ChatReply = {
  text: string
  toolCalls: ToolCall[]
  usage: { inputTokens: number; outputTokens: number }
}

// The model can't answer right now: switched off, too slow, rate-limited, or the provider
// failed. The receptionist catches this one error and takes a message instead.
export class LlmUnavailable extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LlmUnavailable'
  }
}

// The longest reply, in tokens, unless a request sets its own. Phone replies are far shorter.
export const DEFAULT_MAX_TOKENS = 1024
