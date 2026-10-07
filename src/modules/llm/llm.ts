import { env } from '../../config/env.ts'
import { logger } from '../../lib/logger.ts'
import * as anthropic from './anthropic.ts'
import * as groq from './groq.ts'
import { type ChatReply, type ChatRequest, LlmUnavailable } from './types.ts'

export * from './types.ts'

// The one door to a language model. Callers never name a provider: LLM_PROVIDER picks it.
// Any failure comes out as LlmUnavailable.
export async function chat(request: ChatRequest): Promise<ChatReply> {
  const started = Date.now()
  let reply: ChatReply
  if (env.LLM_PROVIDER === 'groq') reply = await groq.chat(request)
  else if (env.LLM_PROVIDER === 'anthropic') reply = await anthropic.chat(request)
  else throw new LlmUnavailable('LLM_PROVIDER is off')

  // Token counts and time per reply, to compare providers on real numbers.
  logger.info({ provider: env.LLM_PROVIDER, ms: Date.now() - started, ...reply.usage }, 'LLM reply')
  return reply
}
