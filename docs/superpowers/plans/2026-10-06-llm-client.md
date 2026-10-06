# LLM Client Implementation Plan

**Goal:** One provider-free `chat()` function with Groq and Claude Haiku 4.5 behind it, picked by
`LLM_PROVIDER`.

**Architecture:** `src/modules/llm/`: `llm.ts` (types, `chat()`, `LlmUnavailable`), `groq.ts`
(fetch), `anthropic.ts` (official `@anthropic-ai/sdk`). Pure mapping functions per provider are
unit tested; nothing in the test suite calls a real model.

**Spec:** `relay-api/docs/superpowers/specs/2026-10-06-llm-client-design.md`

## Global Constraints

- Branch `feat/llm-client` in `relay-api`, from `main`.
- Lean, plain code a junior developer can debug without AI. Short "why" comments.
- Commit messages lowercase conventional. No `Co-Authored-By` trailer.
- Biome only on touched files. Keys go in `.env` only.

## Task 1: settings

- [ ] `src/config/env.ts`: `LLM_PROVIDER` (`off | groq | anthropic`, default `off`), `GROQ_API_KEY`,
      `GROQ_MODEL` (default `openai/gpt-oss-20b`), `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`
      (default `claude-haiku-4-5`), `LLM_TIMEOUT_MS` (default 8000). In `superRefine`, the key is
      required for the chosen provider, like `SMS_PROVIDER=httpsms`.
- [ ] `.env.example` (if present) and the README's settings list.

## Task 2: types, `chat()`, Groq

- [ ] `src/modules/llm/llm.ts`: the types from the spec, `LlmUnavailable`, and
      ```ts
      export async function chat(request: ChatRequest): Promise<ChatReply> {
        const started = Date.now()
        const reply =
          env.LLM_PROVIDER === 'groq' ? await groq.chat(request)
          : env.LLM_PROVIDER === 'anthropic' ? await anthropic.chat(request)
          : unavailable('LLM_PROVIDER is off')
        logger.info({ provider: env.LLM_PROVIDER, ms: Date.now() - started, ...reply.usage }, 'LLM reply')
        return reply
      }
      ```
- [ ] `src/modules/llm/groq.ts`: `toGroqBody(request, model)` and `fromGroqResponse(json)` (pure,
      exported for tests), and `chat()` that posts with `AbortSignal.timeout(env.LLM_TIMEOUT_MS)`.
      Any non-2xx, abort or network error → `throw new LlmUnavailable(...)` with the status in the
      message. Mapping:
      - system → `{ role: 'system', content }` first;
      - assistant with tool calls → `{ role: 'assistant', content: text || null, tool_calls: [{ id,
        type: 'function', function: { name, arguments: JSON.stringify(input) } }] }`;
      - our `tool` message → one `{ role: 'tool', tool_call_id, content: output }` per result;
      - response `choices[0].message.tool_calls[].function.arguments` → `safeJsonParse`.
- [ ] `groq.test.ts`, `llm.test.ts`.
- [ ] Commit `feat: llm client with groq`.

## Task 3: Claude Haiku 4.5

- [ ] `npm install @anthropic-ai/sdk`.
- [ ] `src/modules/llm/anthropic.ts`: one `new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 0 })`
      (no retries: the caller is waiting). `toAnthropicParams(request, model)`,
      `fromAnthropicMessage(message)` (pure, tested), `chat()` calling
      `client.messages.create(params, { signal: AbortSignal.timeout(env.LLM_TIMEOUT_MS) })`.
      Use the SDK's types (`Anthropic.MessageParam`, `Anthropic.Tool`, `Anthropic.Message`)
      inside this file. Mapping:
      - our `user` → `{ role: 'user', content: text }`;
      - assistant → `{ role: 'assistant', content: [text block if any, ...tool_use blocks] }`;
      - our `tool` → `{ role: 'user', content: results.map(r => ({ type: 'tool_result', tool_use_id: r.toolCallId, content: r.output })) }`;
      - reply: `text` blocks joined, `tool_use` blocks → `{ id, name, input }`; check
        `stop_reason`: `refusal` or `max_tokens` with no text and no tool call → `LlmUnavailable`.
      Errors: `catch (error)`; `Anthropic.APIError` and connection errors → `LlmUnavailable`;
      rethrow anything else.
- [ ] `anthropic.test.ts`.
- [ ] Commit `feat: claude haiku as a second llm provider`.

## Task 4: try it once by hand

- [ ] With a real key in `.env`, a throwaway script in the scratch folder (not committed) that
      sends one tool-using request to each provider and prints the reply and timing.
