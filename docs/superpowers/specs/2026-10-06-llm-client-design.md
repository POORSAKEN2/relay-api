# LLM client

Date: 2026-10-06. Status: proposed. Plan: `docs/superpowers/plans/2026-10-06-llm-client.md`.
Depends on: nothing. Used by: the receptionist engine and call wrap-up.
Roadmap: `specs/2026-10-06-mvp-remaining-work.md` (step 4).

## Problem

The AI receptionist needs a language model that can answer in text and ask for tool calls
(check a ZIP, list windows, book). The tech stack doc picks Groq's free tier (`gpt-oss-20b`)
for the demo, "behind a swappable wrapper; a paid API such as Claude Haiku 4.5 is a settings
change". Nothing calls an LLM in `relay-api` yet.

## Goal

1. One function, `chat()`, that the rest of the code calls. It never names a provider.
2. Groq works first. Claude Haiku 4.5 is a second provider file, picked by a setting.
3. Tests never call a real model.
4. Slow or failing models fail fast with one error type the engine can handle.

## Out of scope

- Streaming replies word by word. Phone replies are one or two short sentences.
- Retries. A phone caller can't wait for a retry; the engine falls back instead.
- Prompt caching. Haiku 4.5's minimum cacheable prefix is larger than the receptionist prompt.

## Design

```
receptionist/engine ─► llm/llm.ts  chat()
                          ├► llm/groq.ts       fetch, OpenAI-style chat completions
                          └► llm/anthropic.ts  @anthropic-ai/sdk (official SDK)
```

Folder `src/modules/llm/`. Like `messaging/httpsms.ts`, each provider file is the only place
that knows its provider's shapes.

### Types (ours, provider-free)

```ts
export type ToolSpec = { name: string; description: string; parameters: JsonSchemaObject }
export type ToolCall = { id: string; name: string; input: unknown }
export type ChatMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls: ToolCall[] }
  | { role: 'tool'; results: { toolCallId: string; name: string; output: string }[] }
export type ChatRequest = { system: string; messages: ChatMessage[]; tools: ToolSpec[]; maxTokens?: number }
export type ChatReply = { text: string; toolCalls: ToolCall[]; usage: { inputTokens: number; outputTokens: number } }

export class LlmUnavailable extends Error {} // off, timed out, rate-limited, provider error
export async function chat(request: ChatRequest): Promise<ChatReply>
```

The engine works only with these. Tool results of one turn travel together in one `tool`
message, which maps cleanly to both providers (Anthropic wants all `tool_result` blocks of a turn
in one user message).

### Settings

| Variable | Values | Default |
|---|---|---|
| `LLM_PROVIDER` | `off`, `groq`, `anthropic` | `off` |
| `GROQ_API_KEY` | key | required with `groq` |
| `GROQ_MODEL` | model id | `openai/gpt-oss-20b` |
| `ANTHROPIC_API_KEY` | key | required with `anthropic` |
| `ANTHROPIC_MODEL` | model id | `claude-haiku-4-5` |
| `LLM_TIMEOUT_MS` | ms | `8000` |

`off` makes every `chat()` throw `LlmUnavailable`, so the engine's fallback runs (take a message).
Tests use `off` unless they mock `chat`.

### Groq

`POST https://api.groq.com/openai/v1/chat/completions` with `fetch` (no SDK: one request
shape). Tools as `{ type: 'function', function: { name, description, parameters } }`; tool calls
come back with `arguments` as a JSON string, parsed with `JSON.parse` inside a `try` (invalid JSON
→ the call is passed on with `input = null`, and the tool handler's zod check rejects it, so the
model is told and can retry).

### Anthropic

The official SDK (`@anthropic-ai/sdk`), `client.messages.create({ model, max_tokens, system,
messages, tools })`. Tools as `{ name, description, input_schema }`. Reply `content` blocks:
`text` → text, `tool_use` → tool call. Our `tool` message → one `user` message of `tool_result`
blocks. No `thinking` parameter for Haiku 4.5 (thinking off is the fastest for a phone call).
Errors: the SDK's typed errors (`Anthropic.RateLimitError`, `Anthropic.APIError`, connection
errors) all become `LlmUnavailable`.

### Timeout

Each request gets `AbortSignal.timeout(LLM_TIMEOUT_MS)`. A caller waiting more than about two
seconds hears silence, so the engine also keeps replies short; the timeout is the backstop.

### Cost logging

Every reply's token counts are logged (`logger.info({ provider, model, inputTokens,
outputTokens, ms }, 'LLM reply')`) so the Groq vs Haiku comparison has real numbers.

## Testing

- `groq.test.ts`, `anthropic.test.ts`: the pure mapping functions only (our messages → provider
  request body; provider response → `ChatReply`), including a tool call, a tool result turn,
  and bad tool-call JSON. No network.
- `llm.test.ts`: `off` throws `LlmUnavailable`; the provider is picked from the setting.
- `env.test.ts` (or the existing env checks): `groq` without `GROQ_API_KEY` fails at startup.
