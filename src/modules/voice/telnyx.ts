import { env } from '../../config/env.ts'

// Telnyx (https://telnyx.com): our phone number lives there. For each step of a call Telnyx
// posts an event to /api/webhooks/telnyx, and we answer with a command (answer, speak, hang up).
// The only file that sends commands to Telnyx.

const CALLS_URL = 'https://api.telnyx.com/v2/calls'

// Sends one command for one call. Throws if Telnyx doesn't take it.
// `commandId` makes a retry safe: Telnyx ignores a command whose id it has already seen for
// the same call, so a repeated webhook can't answer or speak twice.
export async function sendCallCommand(
  callControlId: string,
  command: 'answer' | 'speak' | 'hangup',
  commandId: string,
  options: object = {},
) {
  const res = await fetch(`${CALLS_URL}/${encodeURIComponent(callControlId)}/actions/${command}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.TELNYX_API_KEY ?? ''}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ command_id: commandId, ...options }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) {
    throw new Error(`Telnyx ${command} answered ${res.status}: ${(await res.text()).slice(0, 300)}`)
  }
}
