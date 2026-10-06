import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../app.ts'
import { env } from '../../config/env.ts'
import { TEST_GREETING } from './voice.service.ts'

const app = createApp()

// A key pair standing in for Telnyx's: the private half signs, the public half goes in env.
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const PUBLIC_KEY = Buffer.from(publicKey.export({ format: 'jwk' }).x ?? '', 'base64url').toString(
  'base64',
)

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  env.TELNYX_PUBLIC_KEY = PUBLIC_KEY
  env.TELNYX_API_KEY = 'test-telnyx-api-key'
  fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  env.TELNYX_PUBLIC_KEY = undefined
  env.TELNYX_API_KEY = undefined
  vi.unstubAllGlobals()
})

function event(type: string, payload: object = {}, id: string = randomUUID()) {
  return JSON.stringify({
    data: {
      record_type: 'event',
      id,
      event_type: type,
      payload: { call_control_id: 'call-1', direction: 'incoming', ...payload },
    },
  })
}

function signature(body: string, timestamp: string) {
  return sign(null, Buffer.from(`${timestamp}|${body}`), privateKey).toString('base64')
}

function now() {
  return String(Math.floor(Date.now() / 1000))
}

function post(body: string, timestamp = now(), sig = signature(body, timestamp)) {
  return request(app)
    .post('/api/webhooks/telnyx')
    .set('content-type', 'application/json')
    .set('telnyx-timestamp', timestamp)
    .set('telnyx-signature-ed25519', sig)
    .send(body)
}

// The commands sent to Telnyx, as [command, body].
function commands() {
  return fetchMock.mock.calls.map(([url, init]) => [
    String(url).split('/actions/')[1],
    JSON.parse(init.body),
  ])
}

describe('POST /api/webhooks/telnyx: signature', () => {
  it('refuses a request without a signature', async () => {
    await request(app)
      .post('/api/webhooks/telnyx')
      .set('content-type', 'application/json')
      .send(event('call.initiated'))
      .expect(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a signature made with another key', async () => {
    const other = generateKeyPairSync('ed25519').privateKey
    const body = event('call.initiated')
    const timestamp = now()
    const forged = sign(null, Buffer.from(`${timestamp}|${body}`), other).toString('base64')
    await post(body, timestamp, forged).expect(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a body changed after signing', async () => {
    const timestamp = now()
    const sig = signature(event('call.initiated', {}, 'event-1'), timestamp)
    await post(event('call.initiated', {}, 'event-2'), timestamp, sig).expect(401)
  })

  it('refuses a signature older than 5 minutes', async () => {
    const old = String(Math.floor(Date.now() / 1000) - 6 * 60)
    await post(event('call.initiated'), old).expect(401)
  })

  it('refuses a timestamp that is not a number', async () => {
    const body = event('call.initiated')
    await post(body, 'soon', signature(body, 'soon')).expect(401)
  })

  it('refuses everything when TELNYX_PUBLIC_KEY is not set', async () => {
    env.TELNYX_PUBLIC_KEY = undefined
    await post(event('call.initiated')).expect(401)
  })
})

describe('POST /api/webhooks/telnyx: the setup test call', () => {
  it('answers an incoming call', async () => {
    await post(event('call.initiated', {}, 'event-1')).expect(200)
    expect(commands()).toEqual([['answer', { command_id: 'event-1' }]])
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.telnyx.com/v2/calls/call-1/actions/answer')
    expect(init.headers.authorization).toBe('Bearer test-telnyx-api-key')
  })

  it('does not answer an outgoing call', async () => {
    await post(event('call.initiated', { direction: 'outgoing' })).expect(200)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('speaks the test line once the call is answered', async () => {
    await post(event('call.answered', {}, 'event-2')).expect(200)
    expect(commands()).toEqual([
      [
        'speak',
        { command_id: 'event-2', payload: TEST_GREETING, voice: 'AWS.Polly.Joanna-Neural' },
      ],
    ])
  })

  it('hangs up when the line has been spoken', async () => {
    await post(event('call.speak.ended', {}, 'event-3')).expect(200)
    expect(commands()).toEqual([['hangup', { command_id: 'event-3' }]])
  })

  it('accepts other events without sending a command', async () => {
    await post(event('call.hangup')).expect(200)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('answers 500 when Telnyx refuses a command, so Telnyx sends the event again', async () => {
    fetchMock.mockResolvedValueOnce(new Response('call not found', { status: 422 }))
    await post(event('call.initiated')).expect(500)
  })
})
