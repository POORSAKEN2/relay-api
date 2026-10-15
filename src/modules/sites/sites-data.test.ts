import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { createShop, createSite, resetDb } from '../../../test/helpers.ts'
import { db } from '../../db/client.ts'
import { phoneNumbers, services, sitePhotos } from '../../db/schema.ts'
import { loadPublicSite } from './sites.service.ts'

beforeEach(resetDb)

describe('loadPublicSite', () => {
  it('is undefined before the site is saved', async () => {
    const shop = await createShop('desert')
    expect(await loadPublicSite(shop.tenant)).toBeUndefined()
  })

  it('shows the contact phone when there is no Relay number', async () => {
    const shop = await createShop('desert')
    await createSite(shop.tenant.id)
    expect((await loadPublicSite(shop.tenant))?.phone).toBe('+14805550100')
  })

  it('prefers the active Relay number and skips a released one', async () => {
    const shop = await createShop('desert')
    await createSite(shop.tenant.id)
    await db.insert(phoneNumbers).values([
      { tenantId: shop.tenant.id, number: '+16025550199', status: 'released' },
      { tenantId: shop.tenant.id, number: '+16025550142', status: 'active' },
    ])
    expect((await loadPublicSite(shop.tenant))?.phone).toBe('+16025550142')
  })

  it('leaves out archived services and uses default colors', async () => {
    const shop = await createShop('desert')
    await createSite(shop.tenant.id)
    await db
      .update(services)
      .set({ archivedAt: new Date() })
      .where(eq(services.id, shop.service.id))
    const data = await loadPublicSite(shop.tenant)
    expect(data?.services).toEqual([])
    expect(data?.branding).toEqual({
      primaryColor: '#1d4ed8',
      accentColor: '#0ea5e9',
      logoAssetId: null,
      faviconAssetId: null,
    })
  })

  it('lists photos without their bytes', async () => {
    const shop = await createShop('desert')
    await createSite(shop.tenant.id)
    const data = Buffer.from([0xff, 0xd8, 0xff, 0x00])
    await db.insert(sitePhotos).values({
      tenantId: shop.tenant.id,
      kind: 'hero',
      contentType: 'image/jpeg',
      data,
      altText: 'Van',
      createdBy: shop.office.id,
    })
    const [photo] = (await loadPublicSite(shop.tenant))!.photos
    expect(photo).toEqual({ id: expect.any(String), kind: 'hero', altText: 'Van' })
  })
})
