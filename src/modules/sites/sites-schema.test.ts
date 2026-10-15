import { beforeEach, expect, it } from 'vitest'
import { createTenant, resetDb } from '../../../test/helpers.ts'
import { db } from '../../db/client.ts'
import { sites } from '../../db/schema.ts'

beforeEach(resetDb)

const valid = {
  headline: 'Cool again today',
  intro: 'AC repair across Phoenix.',
  city: 'Phoenix',
  region: 'AZ',
}

it('saves one site per contractor, with the defaults', async () => {
  const desert = await createTenant('desert')
  const [site] = await db
    .insert(sites)
    .values({ tenantId: desert.id, ...valid })
    .returning()
  expect(site).toMatchObject({
    design: 'breeze',
    publishedAt: null,
    citiesServed: [],
    emergencyService: false,
    showPrices: true,
  })
  await expect(db.insert(sites).values({ tenantId: desert.id, ...valid })).rejects.toThrow()
})

it.each([
  ['an unknown design', { design: 'fancy' }],
  ['a 121-character headline', { headline: 'x'.repeat(121) }],
  ['a spelled-out region', { region: 'Arizona' }],
  ['31 cities', { citiesServed: Array.from({ length: 31 }, (_, i) => `City ${i}`) }],
])('refuses %s', async (_name, values) => {
  const desert = await createTenant('desert')
  const row = { tenantId: desert.id, ...valid, ...values } as typeof sites.$inferInsert
  await expect(db.insert(sites).values(row)).rejects.toThrow()
})
