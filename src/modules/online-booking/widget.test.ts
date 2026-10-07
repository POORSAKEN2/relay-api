import { eq } from 'drizzle-orm'
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'
import { createShop, createUser, resetDb } from '../../../test/helpers.ts'
import { createApp } from '../../app.ts'
import { db } from '../../db/client.ts'
import { brandingVersions, tenants } from '../../db/schema.ts'
import { DEFAULT_COLORS } from '../branding/branding.service.ts'

const app = createApp()

beforeEach(resetDb)

// Asked the way widget.js asks from a contractor's own website: another origin, no cookie.
function widget(host: string) {
  return request(app)
    .get('/api/online-booking/widget')
    .query({ host })
    .set('Origin', 'https://desertbreezeair.com')
}

describe('GET /api/online-booking/widget', () => {
  it('gives the button the contractor’s brand color, to any website', async () => {
    const shop = await createShop('desert')
    const admin = await createUser('superadmin', null)
    await db.insert(brandingVersions).values({
      tenantId: shop.tenant.id,
      primaryColor: '#0f766e',
      accentColor: '#f59e0b',
      createdBy: admin.id,
    })

    const res = await widget('desert.localhost').expect(200)
    expect(res.body).toEqual({ primaryColor: '#0f766e', open: true })
    expect(res.headers['access-control-allow-origin']).toBe('*')
    expect(res.headers['access-control-allow-credentials']).toBeUndefined()
    expect(res.headers['cache-control']).toBe('public, max-age=300')
  })

  it('uses the default color before the contractor has one', async () => {
    await createShop('desert')

    const res = await widget('desert.localhost').expect(200)
    expect(res.body).toEqual({ primaryColor: DEFAULT_COLORS.primaryColor, open: true })
  })

  it('says the booking page is off for a suspended contractor', async () => {
    const shop = await createShop('desert')
    await db.update(tenants).set({ status: 'suspended' }).where(eq(tenants.id, shop.tenant.id))

    const res = await widget('desert.localhost').expect(200)
    expect(res.body.open).toBe(false)
  })

  it('knows no other address', async () => {
    await createShop('desert')

    await widget('nobody.localhost').expect(404)
    await widget('localhost').expect(404)
    await request(app).get('/api/online-booking/widget').expect(400)
  })
})
