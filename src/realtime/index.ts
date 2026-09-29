import type { Server as HttpServer } from 'node:http'
import * as Sentry from '@sentry/node'
import { Server } from 'socket.io'
import { checkOrigin } from '../lib/origins.ts'
import { readSessionToken } from '../middleware/auth.ts'
import { validateSession } from '../modules/accounts/accounts.service.ts'
import type { RealtimeEvents } from './events.ts'

let io: Server | undefined

// Each contractor's signed-in staff share one room, so a shop only sees its own updates.
export function attachRealtime(httpServer: HttpServer): Server {
  io = new Server(httpServer, { cors: { origin: checkOrigin, credentials: true } })

  io.use(async (socket, next) => {
    try {
      const token = readSessionToken(socket.handshake.headers.cookie)
      const session = token ? await validateSession(token, { renew: false }) : null
      if (!session?.user.tenantId) return next(new Error('unauthorized'))
      socket.data.tenantId = session.user.tenantId
      next()
    } catch (error) {
      Sentry.captureException(error)
      next(new Error('server_error'))
    }
  })

  io.on('connection', (socket) => {
    socket.join(roomFor(socket.data.tenantId))
  })

  return io
}

export function emitToTenant<E extends keyof RealtimeEvents>(
  tenantId: string,
  event: E,
  payload: RealtimeEvents[E],
) {
  io?.to(roomFor(tenantId)).emit(event, payload)
}

function roomFor(tenantId: string): string {
  return `tenant:${tenantId}`
}
