import { z } from 'zod'
import { logger } from '../../lib/logger.ts'
import { sendCallCommand } from './telnyx.ts'

// What Telnyx posts to /api/webhooks/telnyx. Only the fields we use.
export const TelnyxEvent = z.object({
  data: z.object({
    id: z.string().min(1),
    event_type: z.string(),
    payload: z
      .object({
        call_control_id: z.string().nullish(),
        direction: z.string().nullish(), // 'incoming' for a call to our number
        from: z.string().nullish(),
        to: z.string().nullish(),
      })
      .default({}),
  }),
})
export type TelnyxEvent = z.infer<typeof TelnyxEvent>

// Setup check only (docs/telnyx-setup.md): answer, say one line, hang up. The AI receptionist
// replaces this.
export const TEST_GREETING = 'Hello from Relay. Telnyx is connected.'
const VOICE = 'AWS.Polly.Joanna-Neural'

// One event, one command back. The event id is the command id, so a repeated event is ignored
// by Telnyx instead of answering or speaking twice.
export async function handleTelnyxEvent(event: TelnyxEvent) {
  const { id, event_type: type, payload } = event.data
  const callControlId = payload.call_control_id
  logger.info({ type, callControlId, from: payload.from, to: payload.to }, 'Telnyx call event')
  if (!callControlId) return

  switch (type) {
    case 'call.initiated':
      if (payload.direction === 'incoming') await sendCallCommand(callControlId, 'answer', id)
      break
    case 'call.answered':
      await sendCallCommand(callControlId, 'speak', id, { payload: TEST_GREETING, voice: VOICE })
      break
    case 'call.speak.ended':
      await sendCallCommand(callControlId, 'hangup', id)
      break
  }
}
