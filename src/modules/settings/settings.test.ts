import { eq } from 'drizzle-orm'
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'
import { createShop, createUser, resetDb, type Shop, signIn } from '../../../test/helpers.ts'
import { createApp } from '../../app.ts'
import { db } from '../../db/client.ts'
import { auditEvents, tenants } from '../../db/schema.ts'

const app = createApp()

beforeEach(resetDb)

function getSettings(shop: Shop) {
  return request(app).get('/api/settings/booking').set('Cookie', shop.cookie)
}

function setFee(shop: Shop, priorityFeeCents: unknown) {
  return request(app)
    .put('/api/settings/priority-fee')
    .set('Cookie', shop.cookie)
    .send({ priorityFeeCents })
}

function setArea(shop: Shop, zips: unknown) {
  return request(app).put('/api/settings/service-area').set('Cookie', shop.cookie).send({ zips })
}

describe('GET /api/settings/booking', () => {
  it('starts with no priority fee and an empty service area', async () => {
    const shop = await createShop('desert')

    const res = await getSettings(shop).expect(200)
    expect(res.body).toEqual({ priorityFeeCents: 0, zips: [] })
  })

  it('gives each contractor only its own settings', async () => {
    const shop = await createShop('desert')
    const other = await createShop('other')
    await setFee(other, 9900).expect(200)
    await setArea(other, ['90210']).expect(200)

    const res = await getSettings(shop).expect(200)
    expect(res.body).toEqual({ priorityFeeCents: 0, zips: [] })
  })
})

describe('PUT /api/settings/priority-fee', () => {
  it('saves the fee and records who changed it', async () => {
    const shop = await createShop('desert')

    const res = await setFee(shop, 4900).expect(200)
    expect(res.body).toEqual({ priorityFeeCents: 4900, zips: [] })

    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, shop.tenant.id))
    expect(tenant.priorityFeeCents).toBe(4900)
    const audit = await db.select().from(auditEvents)
    expect(audit).toEqual([
      expect.objectContaining({
        actorUserId: shop.office.id,
        action: 'settings.priority_fee_updated',
        data: { priorityFeeCents: 4900 },
      }),
    ])
  })

  it('turns priority service off with a fee of $0', async () => {
    const shop = await createShop('desert')
    await setFee(shop, 4900).expect(200)

    const res = await setFee(shop, 0).expect(200)
    expect(res.body.priorityFeeCents).toBe(0)
  })

  it('refuses a fee that isn’t whole cents of $0 or more', async () => {
    const shop = await createShop('desert')

    const negative = await setFee(shop, -1).expect(400)
    expect(negative.body.error.details).toEqual({ priorityFeeCents: ['Enter a fee of $0 or more'] })
    const fraction = await setFee(shop, 49.5).expect(400)
    expect(fraction.body.error.details).toEqual({
      priorityFeeCents: ['Enter a fee in dollars and cents'],
    })
    await setFee(shop, '49').expect(400)
  })
})

describe('PUT /api/settings/service-area', () => {
  it('saves the ZIP codes sorted, each one once', async () => {
    const shop = await createShop('desert')

    const res = await setArea(shop, ['85281', '85004', ' 85281 ']).expect(200)
    expect(res.body).toEqual({ priorityFeeCents: 0, zips: ['85004', '85281'] })

    const audit = await db.select().from(auditEvents)
    expect(audit).toEqual([
      expect.objectContaining({ action: 'settings.service_area_updated', data: { zips: 2 } }),
    ])
  })

  it('replaces the whole list, and an empty list clears it', async () => {
    const shop = await createShop('desert')
    await setArea(shop, ['85004', '85281']).expect(200)

    const replaced = await setArea(shop, ['85201']).expect(200)
    expect(replaced.body.zips).toEqual(['85201'])
    const cleared = await setArea(shop, []).expect(200)
    expect(cleared.body.zips).toEqual([])
  })

  it('leaves other contractors’ service areas alone', async () => {
    const shop = await createShop('desert')
    const other = await createShop('other')
    await setArea(other, ['85004']).expect(200)

    await setArea(shop, ['85004', '85281']).expect(200)
    await setArea(shop, []).expect(200)

    expect((await getSettings(other)).body.zips).toEqual(['85004'])
  })

  it('refuses anything that isn’t a 5-digit ZIP code and keeps the saved list', async () => {
    const shop = await createShop('desert')
    await setArea(shop, ['85004']).expect(200)

    const res = await setArea(shop, ['85281', '8528', 'ABCDE']).expect(400)
    expect(res.body.error.details).toEqual({
      'zips.1': ['Enter a 5-digit ZIP code'],
      'zips.2': ['Enter a 5-digit ZIP code'],
    })
    expect((await getSettings(shop)).body.zips).toEqual(['85004'])
  })
})

it('is for owner and office staff only', async () => {
  const shop = await createShop('desert')
  const owner = await createUser('owner', shop.tenant.id)
  const admin = await createUser('superadmin', null)

  await request(app).get('/api/settings/booking').expect(401)
  await request(app).put('/api/settings/priority-fee').send({ priorityFeeCents: 100 }).expect(401)
  await request(app).put('/api/settings/service-area').send({ zips: [] }).expect(401)
  await request(app)
    .get('/api/settings/booking')
    .set('Cookie', await signIn(admin.email))
    .expect(403)
  await request(app)
    .put('/api/settings/priority-fee')
    .set('Cookie', await signIn(owner.email))
    .send({ priorityFeeCents: 100 })
    .expect(200)
})

describe('GET /api/settings/booking-links', () => {
  function getLinks(shop: Shop) {
    return request(app).get('/api/settings/booking-links').set('Cookie', shop.cookie)
  }

  it('gives the booking link, the Google link and the website snippet', async () => {
    const shop = await createShop('desert')

    const res = await getLinks(shop).expect(200)
    expect(res.body).toEqual({
      bookingUrl: 'https://desert.localhost/',
      googleUrl: 'https://desert.localhost/?from=google',
      widgetSnippet: '<script src="https://desert.localhost/widget.js" async></script>',
    })
  })

  it('uses the contractor’s own domain once it is verified', async () => {
    const shop = await createShop('desert')
    const where = eq(tenants.id, shop.tenant.id)
    await db.update(tenants).set({ customDomain: 'book.desertbreeze.com' }).where(where)
    expect((await getLinks(shop).expect(200)).body.bookingUrl).toBe('https://desert.localhost/')

    await db.update(tenants).set({ customDomainVerifiedAt: new Date() }).where(where)
    expect((await getLinks(shop).expect(200)).body).toMatchObject({
      bookingUrl: 'https://book.desertbreeze.com/',
      googleUrl: 'https://book.desertbreeze.com/?from=google',
    })
  })

  it('is for the contractor’s staff only', async () => {
    const shop = await createShop('desert')
    const technician = await createUser('technician', shop.tenant.id)

    await request(app).get('/api/settings/booking-links').expect(401)
    await request(app)
      .get('/api/settings/booking-links')
      .set('Cookie', await signIn(technician.email))
      .expect(403)
  })
})
