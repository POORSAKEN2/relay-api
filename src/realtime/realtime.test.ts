import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Server } from 'socket.io'
import { io as connect, type Socket } from 'socket.io-client'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { createTenant, createUser, resetDb, signIn } from '../../test/helpers.ts'
import { attachRealtime, emitToTenant } from './index.ts'

let io: Server
let url: string

beforeAll(async () => {
  const httpServer = createServer()
  io = attachRealtime(httpServer)
  await new Promise<void>((resolve) => httpServer.listen(0, resolve))
  url = `http://localhost:${(httpServer.address() as AddressInfo).port}`
})

afterAll(() => io.close())

beforeEach(resetDb)

function connectWith(cookie?: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(url, {
      transports: ['websocket'],
      reconnection: false,
      extraHeaders: cookie ? { cookie } : {},
    })
    socket.on('connect', () => resolve(socket))
    socket.on('connect_error', (error) => {
      socket.close()
      reject(error)
    })
  })
}

it('refuses a connection without a session', async () => {
  await expect(connectWith()).rejects.toThrow('unauthorized')
})

it('refuses a superadmin, who belongs to no contractor', async () => {
  const admin = await createUser('superadmin', null)
  await expect(connectWith(await signIn(admin.email))).rejects.toThrow('unauthorized')
})

it("delivers events only to the contractor's own room", async () => {
  const desert = await createTenant('desert')
  const other = await createTenant('other')
  const owner = await createUser('owner', desert.id)
  const socket = await connectWith(await signIn(owner.email))
  const received: unknown[] = []
  socket.on('branding.updated', (payload) => received.push(payload))

  // Events to one socket arrive in order, so a leak from other would show up first.
  emitToTenant(other.id, 'branding.updated', { tenantId: other.id })
  emitToTenant(desert.id, 'branding.updated', { tenantId: desert.id })

  await vi.waitFor(() => expect(received).toEqual([{ tenantId: desert.id }]))
  socket.close()
})
