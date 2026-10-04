import { strFromU8, unzipSync } from 'fflate'
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  createJob,
  createShop,
  createUser,
  resetDb,
  type Shop,
  signIn,
  signInTechnician,
} from '../../../test/helpers.ts'
import { createApp } from '../../app.ts'
import { db } from '../../db/client.ts'
import { auditEvents, customers, invoices, messages } from '../../db/schema.ts'

const app = createApp()

beforeEach(resetDb)

function download(cookie: string) {
  return request(app)
    .post('/api/export')
    .set('Cookie', cookie)
    .buffer(true)
    .parse((res, done) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => done(null, Buffer.concat(chunks)))
    })
}

async function ownerOf(shop: Shop) {
  const owner = await createUser('owner', shop.tenant.id)
  return signIn(owner.email)
}

function unzip(body: Buffer) {
  return Object.fromEntries(
    Object.entries(unzipSync(new Uint8Array(body))).map(([name, bytes]) => [
      name,
      strFromU8(bytes),
    ]),
  )
}

describe('POST /api/export', () => {
  it('zips one CSV per table with only this contractor’s rows', async () => {
    const shop = await createShop('desert')
    const other = await createShop('other')
    const job = await createJob(shop)
    await db.insert(invoices).values({
      tenantId: shop.tenant.id,
      jobId: job.id,
      number: 1,
      totalCents: 8900,
    })
    await db.insert(messages).values({
      tenantId: shop.tenant.id,
      channel: 'sms',
      direction: 'inbound',
      contact: '+16025550111',
      kind: 'inbound',
      body: 'See you, then',
      status: 'received',
    })

    const res = await download(await ownerOf(shop)).expect(200)

    expect(res.headers['content-type']).toBe('application/zip')
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="relay-data-/)
    const files = unzip(res.body)
    expect(Object.keys(files).sort()).toEqual([
      'customers.csv',
      'invoices.csv',
      'jobs.csv',
      'messages.csv',
      'properties.csv',
    ])
    expect(files['customers.csv']).toContain('Maria Lopez')
    expect(files['customers.csv']).not.toContain(other.customer.id)
    expect(files['properties.csv']).toContain('12 Palm St')
    expect(files['jobs.csv']).toContain('AC blowing warm air')
    expect(files['invoices.csv']).toContain('8900')
    expect(files['messages.csv']).toContain('See you, then')
  })

  it('leaves out link secrets and sign-in code texts', async () => {
    const shop = await createShop('desert')
    await createJob(shop, {
      techLinkHash: 'tech-secret-hash',
      manageLinkHash: 'manage-secret-hash',
    })
    await db.insert(messages).values({
      tenantId: shop.tenant.id,
      channel: 'sms',
      direction: 'outbound',
      contact: '+14805550100',
      kind: 'sign_in_code',
      body: 'Your code is 987654',
      status: 'sent',
    })

    const files = unzip((await download(await ownerOf(shop)).expect(200)).body)

    expect(files['jobs.csv']).not.toContain('secret-hash')
    expect(files['jobs.csv']).not.toContain('tech_link_hash')
    expect(files['messages.csv']).not.toContain('987654')
  })

  it('defuses spreadsheet formulas in customer names', async () => {
    const shop = await createShop('desert')
    await db.insert(customers).values({ tenantId: shop.tenant.id, name: '=1+1', source: 'office' })

    const files = unzip((await download(await ownerOf(shop)).expect(200)).body)

    expect(files['customers.csv']).toContain("'=1+1")
  })

  it('pages through more rows than one batch', async () => {
    const shop = await createShop('desert')
    await db.insert(customers).values(
      Array.from({ length: 2500 }, (_, i) => ({
        tenantId: shop.tenant.id,
        name: `Bulk ${i}`,
        source: 'office' as const,
      })),
    )

    const files = unzip((await download(await ownerOf(shop)).expect(200)).body)

    const lines = files['customers.csv'].trim().split('\r\n')
    expect(lines).toHaveLength(1 + 1 + 2500) // header, Maria, bulk rows
    expect(new Set(lines).size).toBe(lines.length)
  })

  it('sends a header-only file for an empty table', async () => {
    const shop = await createShop('desert')

    const files = unzip((await download(await ownerOf(shop)).expect(200)).body)

    expect(files['invoices.csv'].trim().split('\r\n')).toHaveLength(1)
  })

  it('records who downloaded the data', async () => {
    const shop = await createShop('desert')
    await download(await ownerOf(shop)).expect(200)

    const audit = await db.select().from(auditEvents)
    expect(audit).toEqual([
      expect.objectContaining({ action: 'export.downloaded', tenantId: shop.tenant.id }),
    ])
  })

  it('is closed to office staff, technicians and signed-out visitors', async () => {
    const shop = await createShop('desert')

    await download(shop.cookie).expect(403)
    await download(await signInTechnician(shop.mike)).expect(403)
    await request(app).post('/api/export').expect(401)
  })
})
