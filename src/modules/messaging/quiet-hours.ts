import { type Db, db } from '../../db/client.ts'
import * as queries from './messaging.queries.ts'
import { quietUntil } from './rules.ts'

// When quiet hours end for this contractor, if it is quiet hours now; else null.
// sendText() asks when it saves a text, and the sender asks again just before sending
// one, so a text sent late (downtime, a retry) still never goes out at night.
export async function endOfQuietHours(tenantId: string, tx: Db = db) {
  const quiet = await queries.findQuietHours(tenantId, tx)
  return quietUntil(new Date(), quiet.timezone, quiet.start, quiet.end)
}
