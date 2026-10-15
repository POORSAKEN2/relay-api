# Contractor Websites Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Relay hosts a one-page website for every contractor at `<slug>.site.garified.com`, rendered by relay-api from the database, with the content and one of three designs edited on a new Website page in relay-web.

**Architecture:** A new relay-api module, `src/modules/sites/`, holds pure helpers (`html.ts` escaping template, `site-host.ts`, `site-view.ts`), queries, three small services (page and editor, review and FAQ lists, photos), routes, and `designs/` (one TypeScript render function plus one CSS file per design, and a shared `site.js`). A host-gated router renders the page for `<slug>.site.<APP_DOMAIN>`. Routes under `/api/site/...` serve the CSS, script and photos on every host, plus the staff editing API. relay-web gets a `/website` page with forms, list editors and an iframe preview. The demo `contractor-site/` folder becomes the `breeze` design and is then removed.

**Tech Stack:** Node 22 + TypeScript (run directly, `.ts` imports), Express 5, Drizzle ORM + drizzle-kit on Postgres, Zod 4, Vitest + supertest against a test database, Biome. Web: React 19 + TanStack Query + React Router, Vite, Tailwind/shadcn components.

**Spec:** `docs/superpowers/specs/2026-10-12-contractor-sites-design.md`

## Global Constraints

- Branch `feat/contractor-sites` in `relay-api` and in `relay-web` (Task 1 creates both).
- Commit messages: conventional prefix (`feat:`, `docs:`, `chore:`), lower case, **no `Co-Authored-By` line or any other trailer**.
- No new dependencies in either repo.
- Comments in the codebase's voice: plain sentences saying why, no JSDoc.
- Commands run from the repo root: `npm test`, `npm run typecheck`. One file: `npx vitest run <path>`. Run Biome only on touched paths, `npx biome check --write <paths>`, because a run over all of `src` rewrites line endings in unrelated files.
- relay-api tests need `TEST_DATABASE_URL` in `relay-api/.env` (already set up; global setup migrates the test database). In tests `APP_DOMAIN` is `localhost`, so Desert's site host is `desert.site.localhost`.
- Addresses: the page is `/` on `<slug>.site.<APP_DOMAIN>`. Site CSS and script are `/api/site/assets/<file>?v=<hash>`, photos `/api/site/photos/<id>`, and the logo and favicon use the existing `/api/branding/assets/<id>`.
- Section ids, in this order, in every design: `top` (hero), `services`, `how`, `reviews`, `photos`, `about`, `area`, `hours`, `faq`, `book` (closing call to action). The header and footer are `<header>` and `<footer>`. A section with no content isn't rendered at all: no heading, no wrapper.
- Claim copy, exact, built only in `site-view.ts`: `Licensed · <license_number>`, `24/7 emergency service`, `A text when we’re on the way`, `Price approved before work starts`.
- Limits (the same in zod and the database): headline 1–120, intro 1–400, about ≤ 2000, license ≤ 60, city 1–80, region 2 capital letters, ≤ 30 cities of 1–60 characters, review author 1–60, place ≤ 60, rating 1–5, review body 1–600, question 1–200, answer 1–1000, alt text 1–200, photo JPEG or WebP of 1 to 1,048,576 bytes, 1 hero photo, 12 work photos.
- Editing routes use `requireRole('owner', 'office')` and answer with the whole `SiteEditor` (Task 8), so the web page just replaces its copy.
- Errors (code, status, message, exact):

  | Code | Status | Message |
  |---|---|---|
  | `site_not_saved` | 409 | Save your website first. |
  | `site_incomplete` | 409 | Add at least one service on the Services screen first. |
  | `list_changed` | 409 | Your list changed since this page loaded. Refresh and try again. |
  | `not_found` | 404 | Review not found. / Question not found. / Photo not found. |
  | `bad_photo` | 400 | Photos must be JPEG or WebP, up to 1 MB. |
  | `too_many_photos` | 409 | You can show up to 12 work photos. Delete one first. |

- Audit actions (`audit.insertUserAction`): `site.updated`, `site.published`, `site.unpublished` (entity `site`); `site.review_added`, `site.review_updated`, `site.review_deleted`, `site.reviews_reordered` (entity `site_review`); the same four for FAQs, `site.faq_*` and `site.faqs_reordered` (entity `site_faq`); `site.photo_added`, `site.photo_deleted` (entity `site_photo`).
- Two settled gaps in the spec. **Prefill:** tenants have no city, so the empty form's headline is `AC and heating repair, booked online` (not "…in {city}"). **Publish check:** `tenants.contact_phone` is `NOT NULL`, so a phone always exists, and publishing checks only for a saved row and at least one active service.

## Review Focus

Each line has a test in the named task.

1. Contractor text with `<`, quotes or `</script>` (a review, the business name): shown as text everywhere, including attributes and the JSON-LD block. Task 2 (attributes), Task 4 (JSON-LD), Task 6 (page body).
2. A mid-tone brand color such as `#777777`: text on it still reads at WCAG AA. Task 4, `textColorOn`.
3. A site host sent in uppercase, with a port, or with a trailing dot: still finds the site. Task 3.
4. A published site whose services were all archived or whose hours were deleted later: those sections vanish, nothing says "undefined", and JSON-LD leaves out the empty keys. Task 4 and Task 6.
5. The Website page open in two tabs, reordering after the other tab deleted a review: 409 `list_changed`, never a half-saved order. Task 9.

---

### Task 1: Branches and tables

**Files:**
- Modify: `src/db/schema.ts` (new section "Contractor websites" before the type exports near the end)
- Create: `drizzle/0020_contractor_sites.sql` (generated)
- Test: `src/modules/sites/sites-schema.test.ts`

**Interfaces:**
- Produces (from `src/db/schema.ts`): tables `sites`, `siteReviews`, `siteFaqs`, `sitePhotos`; constants `SITE_DESIGNS = ['breeze', 'clean', 'bold'] as const`, `SITE_PHOTO_KINDS = ['hero', 'work'] as const`, `SITE_PHOTO_TYPES = ['image/jpeg', 'image/webp'] as const`, `SITE_PHOTO_MAX_BYTES = 1_048_576`, `SITE_WORK_PHOTOS_MAX = 12`; types `Site`, `SiteReview`, `SiteFaq` (`$inferSelect`), `SiteDesign`, `SitePhotoKind` (`(typeof X)[number]`).

- [ ] **Step 1: Create the branches and commit the spec and this plan**

```bash
git -C relay-api switch -c feat/contractor-sites
git -C relay-web switch -c feat/contractor-sites
cd relay-api
git add docs/superpowers/specs/2026-10-12-contractor-sites-design.md docs/superpowers/plans/2026-10-12-contractor-sites.md
git commit -m "docs: contractor websites design and plan"
```

- [ ] **Step 2: Write the failing test**

```ts
import { beforeEach, expect, it } from 'vitest'
import { createTenant, resetDb } from '../../../test/helpers.ts'
import { db } from '../../db/client.ts'
import { sites } from '../../db/schema.ts'

beforeEach(resetDb)

const valid = { headline: 'Cool again today', intro: 'AC repair across Phoenix.', city: 'Phoenix', region: 'AZ' }

it('saves one site per contractor, with the defaults', async () => {
  const desert = await createTenant('desert')
  const [site] = await db.insert(sites).values({ tenantId: desert.id, ...valid }).returning()
  expect(site).toMatchObject({ design: 'breeze', publishedAt: null, citiesServed: [], emergencyService: false, showPrices: true })
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
```

- [ ] **Step 3: Run it and see it fail**

Run: `npx vitest run src/modules/sites/sites-schema.test.ts`
Expected: FAIL, `sites` is not exported from `schema.ts`.

- [ ] **Step 4: Add the four tables to `schema.ts`**

Port the spec's SQL ("Data" section) column for column, with the same constraint and index names. `sites.tenantId` is `tenantId().primaryKey()`. `citiesServed` is ``text('cities_served').array().notNull().default(sql`'{}'`)``. Photo bytes use the existing `bytea` custom type, and `createdBy` is a plain foreign key to `users`, like `brandingAssets`. Checks use `oneOf()` with the constants above. Put a one-line comment on each table, taken from the spec.

- [ ] **Step 5: Generate and apply the migration**

Run: `npm run db:generate -- --name contractor_sites`, then `npm run db:migrate`.
Expected: `drizzle/0020_contractor_sites.sql` creates 4 tables and 3 indexes, and its checks match the spec's SQL. The migrate command reports no error.

- [ ] **Step 6: Run the test and see it pass**

Run: `npx vitest run src/modules/sites/sites-schema.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 7: Typecheck, lint, commit**

```bash
npm run typecheck
npx biome check --write src/db/schema.ts src/modules/sites
git add src/db/schema.ts drizzle src/modules/sites
git commit -m "feat: tables for contractor websites"
```

---

### Task 2: Escaping HTML template

**Files:**
- Create: `src/modules/sites/html.ts`
- Test: `src/modules/sites/html.test.ts`

**Interfaces:**
- Produces: `class Html { readonly text: string }`, `type HtmlValue = Html | string | number | boolean | null | undefined | HtmlValue[]`, `html(strings: TemplateStringsArray, ...values: HtmlValue[]): Html`, `raw(text: string): Html`, `escapeHtml(text: string): string`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { escapeHtml, html, raw } from './html.ts'

describe('html', () => {
  it('escapes every value it is given', () => {
    expect(html`<p>${'<script>alert(1)</script>'}</p>`.text).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>')
  })

  it('keeps an attribute closed', () => {
    expect(html`<a title="${`" onclick="x' & y`}">`.text).toBe('<a title="&quot; onclick=&quot;x&#39; &amp; y">')
  })

  it('nests templates without escaping them twice', () => {
    expect(html`<ul>${html`<li>${'a&b'}</li>`}</ul>`.text).toBe('<ul><li>a&amp;b</li></ul>')
  })

  it('joins lists and leaves out empty values', () => {
    const items = ['x', 'y'].map((item) => html`<li>${item}</li>`)
    expect(html`${items}${null}${undefined}${false}${0}`.text).toBe('<li>x</li><li>y</li>0')
  })

  it('passes raw text through untouched', () => {
    expect(html`${raw('<b>ok</b>')}`.text).toBe('<b>ok</b>')
  })
})

it('escapeHtml covers the five special characters', () => {
  expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;')
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run src/modules/sites/html.test.ts`
Expected: FAIL, `./html.ts` does not exist.

- [ ] **Step 3: Implement `html.ts`**

`Html` is a small class holding `text`, so a template can tell its own output from contractor text. `null`, `undefined`, `false` and `true` render as `''`, numbers as `String(n)`, and arrays render each item and join with no separator.

- [ ] **Step 4: Run the test and see it pass**

Run: `npx vitest run src/modules/sites/html.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Lint and commit**

```bash
npx biome check --write src/modules/sites/html.ts src/modules/sites/html.test.ts
git add src/modules/sites/html.ts src/modules/sites/html.test.ts
git commit -m "feat: an html template that escapes contractor text"
```

---

### Task 3: Site host and site address

**Files:**
- Create: `src/modules/sites/site-host.ts`
- Modify: `src/lib/tenant-url.ts` (add `siteUrl` below `tenantUrl`)
- Test: `src/modules/sites/site-host.test.ts`

**Interfaces:**
- Produces: `parseSiteHost(host: string, appDomain: string): { slug: string } | null`; `siteUrl(slug: string): string`. In production `siteUrl` returns `https://<slug>.site.<APP_DOMAIN>/`. Otherwise it returns `http://<slug>.site.<APP_DOMAIN>:<PORT>/`, so the dashboard's Open button works on a developer's machine.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { env } from '../../config/env.ts'
import { siteUrl } from '../../lib/tenant-url.ts'
import { parseSiteHost } from './site-host.ts'

describe('parseSiteHost', () => {
  it.each([
    ['desert.site.garified.com', 'desert'],
    ['DESERT.Site.Garified.com', 'desert'],
    ['desert.site.garified.com:443', 'desert'],
    ['desert.site.garified.com.', 'desert'],
    ['desert-breeze.site.garified.com', 'desert-breeze'],
  ])('%s is the site of %s', (host, slug) => {
    expect(parseSiteHost(host, 'garified.com')).toEqual({ slug })
  })

  it.each(['garified.com', 'site.garified.com', 'desert.garified.com', 'api.garified.com', 'a.b.site.garified.com', 'desert.site.other.com', ''])(
    '%s is not a site',
    (host) => {
      expect(parseSiteHost(host, 'garified.com')).toBeNull()
    },
  )

  it('works on a developer machine', () => {
    expect(parseSiteHost('desert.site.localhost:3000', 'localhost')).toEqual({ slug: 'desert' })
  })
})

it('siteUrl points at the local server outside production', () => {
  expect(siteUrl('desert')).toBe(`http://desert.site.localhost:${env.PORT}/`)
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run src/modules/sites/site-host.test.ts`
Expected: FAIL, `./site-host.ts` does not exist.

- [ ] **Step 3: Implement both functions**

`parseSiteHost` trims, lowercases, strips the port and one trailing dot, and requires the suffix `.site.<appDomain>`. The rest must match `/^[a-z0-9-]+$/`, the same slug rule as `parseTenantHost` in `middleware/tenant.ts`. `siteUrl` reads `env.NODE_ENV`, `env.APP_DOMAIN` and `env.PORT`. Its comment says why development differs.

- [ ] **Step 4: Run the test and see it pass**

Run: `npx vitest run src/modules/sites/site-host.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint and commit**

```bash
npx biome check --write src/modules/sites/site-host.ts src/modules/sites/site-host.test.ts src/lib/tenant-url.ts
git add src/modules/sites/site-host.ts src/modules/sites/site-host.test.ts src/lib/tenant-url.ts
git commit -m "feat: find a contractor from their site's host"
```

---

### Task 4: Site view (pure)

**Files:**
- Create: `src/modules/sites/site-view.ts`
- Create: `test/site-fixture.ts` (Desert's site data for tests)
- Test: `src/modules/sites/site-view.test.ts`

**Interfaces:**
- Consumes: `siteUrl` (Task 3); `tenantUrl`, `formatMoney`, `formatPhone`, `formatWindow` from `src/lib`; schema types from Task 1.
- Produces:

```ts
export type PublicSiteData = {
  tenant: Pick<Tenant, 'name' | 'slug' | 'currency' | 'customDomain' | 'customDomainVerifiedAt' | 'textingStatus'>
  site: Site
  phone: string // E.164: the active Relay number, else tenants.contact_phone
  branding: { primaryColor: string; accentColor: string; logoAssetId: string | null; faviconAssetId: string | null }
  services: { name: string; description: string | null; priceType: PriceType; priceCents: number }[]
  hours: { weekday: number; opensAt: string; closesAt: string }[] // '07:00:00'
  reviews: SiteReview[]
  faqs: SiteFaq[]
  photos: { id: string; kind: SitePhotoKind; altText: string }[]
}

export type SiteView = {
  design: SiteDesign
  name: string
  headline: string
  intro: string
  about: string | null
  city: string
  place: string // 'Phoenix, AZ'
  citiesServed: string[]
  licenseNumber: string | null
  emergency: boolean // shows the 24/7 emergency band
  claims: string[] // trust lines, in Global Constraints order, only those the data backs
  phone: { display: string; href: string } // '(602) 555-0142', 'tel:+16025550142'
  bookingUrl: string // tenantUrl(tenant, '/')
  brand: { primary: string; onPrimary: string; accent: string; onAccent: string }
  logoUrl: string | null // '/api/branding/assets/<id>'
  faviconUrl: string | null
  heroPhoto: { url: string; alt: string } | null // url '/api/site/photos/<id>'
  workPhotos: { url: string; alt: string }[]
  services: { name: string; description: string | null; price: string | null }[]
  hours: string[] // ['Mon–Fri 7 AM–7 PM', 'Sat 8 AM–2 PM']
  reviews: { authorName: string; place: string | null; rating: number; body: string }[]
  faqs: { question: string; answer: string }[]
  jsonLd: string // JSON with every '<' written as <
}

export function buildSiteView(data: PublicSiteData): SiteView
export function priceLabel(service: { priceType: PriceType; priceCents: number }, currency: string): string
export function hoursLines(hours: PublicSiteData['hours']): string[]
export function openingHours(hours: PublicSiteData['hours']): string[] // ['Mo-Sa 07:00-19:00']
export function textColorOn(hex: string): '#000000' | '#ffffff'
```

- `test/site-fixture.ts` produces `siteData(overrides?: SiteDataOverrides): PublicSiteData`, where `SiteDataOverrides = Omit<Partial<PublicSiteData>, 'site' | 'tenant'> & { site?: Partial<Site>; tenant?: Partial<PublicSiteData['tenant']> }`. `site` and `tenant` are merged shallowly, and the other keys are replaced. Base values:
  - **tenant:** `Desert Breeze Air` / `desert` / `USD`, no custom domain, `textingStatus: 'approved'`.
  - **site:** design `breeze`, published `2030-01-01`, headline `Too hot inside? We’ll bring it back to 76°.`, intro `AC and heating repair across the Phoenix metro.`, about `Family-run since 2009.`, license `AZ ROC #123456`, `Phoenix` / `AZ`, cities `['Phoenix', 'Mesa']`, emergency `true`, showPrices `true`.
  - **phone:** `+16025550142`.
  - **branding:** `#1d4ed8` / `#0ea5e9`, no logo or favicon.
  - **services:** `AC repair` (description `Diagnosis and repair.`, diagnostic, 8900) and `New-system estimate` (description null, free, 0).
  - **hours:** weekdays 1–6, `07:00:00`–`19:00:00`.
  - **reviews:** one, `Maria G.` / `Mesa` / 5 / `Fixed the same day.`.
  - **faqs:** one, `How do I pay?` / `Card or cash after the visit.`.
  - **photos:** hero `00000000-0000-4000-8000-000000000002` (`Technician at a rooftop unit`) and work `00000000-0000-4000-8000-000000000003` (`New condenser`).

- [ ] **Step 1: Write the fixture, then the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { siteData } from '../../../test/site-fixture.ts'
import { siteUrl } from '../../lib/tenant-url.ts'
import { buildSiteView, hoursLines, openingHours, priceLabel, textColorOn } from './site-view.ts'

const HERO = '00000000-0000-4000-8000-000000000002'
const day = (weekday: number, opensAt: string, closesAt: string) => ({ weekday, opensAt, closesAt })

describe('buildSiteView', () => {
  it('shows every claim the data backs, in order', () => {
    expect(buildSiteView(siteData()).claims).toEqual([
      'Licensed · AZ ROC #123456',
      '24/7 emergency service',
      'A text when we’re on the way',
      'Price approved before work starts',
    ])
  })

  it('drops each claim its data does not back', () => {
    const data = siteData({ site: { licenseNumber: null, emergencyService: false, showPrices: false }, tenant: { textingStatus: 'pending' } })
    expect(buildSiteView(data).claims).toEqual([])
  })

  it('links the phone, booking page, photos and logo', () => {
    const view = buildSiteView(siteData({ branding: { primaryColor: '#1d4ed8', accentColor: '#0ea5e9', logoAssetId: 'logo-id', faviconAssetId: null } }))
    expect(view.phone).toEqual({ display: '(602) 555-0142', href: 'tel:+16025550142' })
    expect(view.bookingUrl).toBe('https://desert.localhost/')
    expect(view.heroPhoto).toEqual({ url: `/api/site/photos/${HERO}`, alt: 'Technician at a rooftop unit' })
    expect(view.workPhotos).toHaveLength(1)
    expect(view.logoUrl).toBe('/api/branding/assets/logo-id')
    expect(view.place).toBe('Phoenix, AZ')
  })

  it('hides prices when show_prices is off', () => {
    const view = buildSiteView(siteData({ site: { showPrices: false } }))
    expect(view.services.map((service) => service.price)).toEqual([null, null])
  })
})

describe('priceLabel', () => {
  it.each([
    ['fixed', 8900, '$89'],
    ['fixed', 8950, '$89.50'],
    ['diagnostic', 8900, '$89 diagnostic'],
    ['free', 0, 'Free estimate'],
  ] as const)('%s %i is %s', (priceType, priceCents, label) => {
    expect(priceLabel({ priceType, priceCents }, 'USD')).toBe(label)
  })
})

describe('hours', () => {
  it('joins days in a row with the same hours, Monday first', () => {
    const hours = [1, 2, 3, 4, 5].map((d) => day(d, '07:00:00', '19:00:00')).concat(day(6, '08:00:00', '14:00:00'))
    expect(hoursLines(hours)).toEqual(['Mon–Fri 7 AM–7 PM', 'Sat 8 AM–2 PM'])
    expect(openingHours(hours)).toEqual(['Mo-Fr 07:00-19:00', 'Sa 08:00-14:00'])
  })

  it('splits around a closed day', () => {
    const hours = [day(1, '08:00:00', '17:00:00'), day(3, '08:00:00', '17:00:00')]
    expect(hoursLines(hours)).toEqual(['Mon 8 AM–5 PM', 'Wed 8 AM–5 PM'])
  })

  it('puts Sunday last when every day is open', () => {
    const hours = [0, 1, 2, 3, 4, 5, 6].map((d) => day(d, '07:00:00', '19:00:00'))
    expect(hoursLines(hours)).toEqual(['Mon–Sun 7 AM–7 PM'])
    expect(openingHours(hours)).toEqual(['Mo-Su 07:00-19:00'])
  })

  it('is empty when no day is open', () => {
    expect(hoursLines([])).toEqual([])
  })
})

it.each([
  ['#ffffff', '#000000'],
  ['#1d4ed8', '#ffffff'],
  ['#f4b02a', '#000000'],
  ['#777777', '#000000'],
  ['#16182b', '#ffffff'],
])('text on %s is %s', (background, text) => {
  expect(textColorOn(background)).toBe(text)
})

describe('jsonLd', () => {
  it('describes the business', () => {
    expect(JSON.parse(buildSiteView(siteData()).jsonLd)).toEqual({
      '@context': 'https://schema.org',
      '@type': 'HVACBusiness',
      name: 'Desert Breeze Air',
      telephone: '+16025550142',
      url: siteUrl('desert'),
      address: { '@type': 'PostalAddress', addressLocality: 'Phoenix', addressRegion: 'AZ', addressCountry: 'US' },
      areaServed: ['Phoenix', 'Mesa'],
      openingHours: ['Mo-Sa 07:00-19:00'],
    })
  })

  it('leaves out an empty service area and hours', () => {
    const json = JSON.parse(buildSiteView(siteData({ hours: [], site: { citiesServed: [] } })).jsonLd)
    expect(json).not.toHaveProperty('areaServed')
    expect(json).not.toHaveProperty('openingHours')
  })

  it('cannot close its own script tag', () => {
    const jsonLd = buildSiteView(siteData({ tenant: { name: '</script><script>x' } })).jsonLd
    expect(jsonLd).not.toContain('<')
    expect(JSON.parse(jsonLd).name).toBe('</script><script>x')
  })
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run src/modules/sites/site-view.test.ts`
Expected: FAIL, `./site-view.ts` does not exist.

- [ ] **Step 3: Implement `site-view.ts`**

- `priceLabel`: whole dollars drop `.00` (use `formatMoney`, then strip a trailing `.00`).
- `hoursLines` and `openingHours`: order the days Monday to Sunday, `[1, 2, 3, 4, 5, 6, 0]`. Group neighbouring open days with equal `opensAt` and `closesAt`, and let a missing day break a group. Labels are `Mon … Sun`. JSON-LD codes are `Mo … Su`, with times written as `HH:MM`.
- `textColorOn`: WCAG relative luminance `L`. Return black when `(L + 0.05) / 0.05 >= 1.05 / (L + 0.05)`, else white. The better of the two always passes 4.5:1. Say so in a comment.
- `jsonLd`: `JSON.stringify(object).replaceAll('<', '\\u003c')`.

- [ ] **Step 4: Run the test and see it pass**

Run: `npx vitest run src/modules/sites/site-view.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
npm run typecheck
npx biome check --write src/modules/sites/site-view.ts src/modules/sites/site-view.test.ts test/site-fixture.ts
git add src/modules/sites/site-view.ts src/modules/sites/site-view.test.ts test/site-fixture.ts
git commit -m "feat: turn a contractor's data into what their site shows"
```

---

### Task 5: Loading a site from the database

**Files:**
- Create: `src/modules/sites/sites.queries.ts`
- Create: `src/modules/sites/sites.service.ts`
- Modify: `test/helpers.ts` (add `createSite`)
- Test: `src/modules/sites/sites-data.test.ts`

**Interfaces:**
- Consumes: `PublicSiteData` (Task 4); `findLatestBranding` (`branding.queries.ts`); `DEFAULT_COLORS` (`branding.service.ts`).
- Produces:
  - `sites.queries.ts`, where every function takes `tenantId` first and an optional `tx: Db = db` last: `findSite`, `findActiveNumber` (`phone_numbers` with status `active`, oldest first, `string | undefined`), `listActiveServices` (unarchived, by `sort_order` then `name`), `listHours`, `listReviews`, `listFaqs` (both by `sort_order` then `created_at`), and `listPhotoRefs` (id, kind, altText only, by `kind`, `sort_order`, `created_at`).
  - `sites.service.ts`: `loadPublicSite(tenant: Tenant): Promise<PublicSiteData | undefined>`, which is undefined when the contractor has no `sites` row.
  - `test/helpers.ts`: `createSite(tenantId: string, values?: Partial<typeof sites.$inferInsert>): Promise<Site>`. Defaults: headline `Cool again today`, intro `AC repair across Phoenix.`, `Phoenix` / `AZ`, `publishedAt: new Date()`.

- [ ] **Step 1: Write the failing test**

```ts
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
    await db.update(services).set({ archivedAt: new Date() }).where(eq(services.id, shop.service.id))
    const data = await loadPublicSite(shop.tenant)
    expect(data?.services).toEqual([])
    expect(data?.branding).toEqual({ primaryColor: '#1d4ed8', accentColor: '#0ea5e9', logoAssetId: null, faviconAssetId: null })
  })

  it('lists photos without their bytes', async () => {
    const shop = await createShop('desert')
    await createSite(shop.tenant.id)
    const data = Buffer.from([0xff, 0xd8, 0xff, 0x00])
    await db.insert(sitePhotos).values({ tenantId: shop.tenant.id, kind: 'hero', contentType: 'image/jpeg', data, altText: 'Van', createdBy: shop.office.id })
    const [photo] = (await loadPublicSite(shop.tenant))!.photos
    expect(photo).toEqual({ id: expect.any(String), kind: 'hero', altText: 'Van' })
  })
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run src/modules/sites/sites-data.test.ts`
Expected: FAIL, `createSite` and `./sites.service.ts` are missing.

- [ ] **Step 3: Add `createSite` and implement the queries and `loadPublicSite`**

`loadPublicSite` returns early when `findSite` finds nothing. Otherwise it runs the other reads with `Promise.all`. Branding falls back to `DEFAULT_COLORS` and null assets. Import the queries as `import * as queries from './sites.queries.ts'` and call them through `queries.`, as other services do. Task 7's 500 test spies on `queries.findSite`.

- [ ] **Step 4: Run the test and see it pass**

Run: `npx vitest run src/modules/sites/sites-data.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck, lint, commit**

```bash
npm run typecheck
npx biome check --write src/modules/sites test/helpers.ts
git add src/modules/sites test/helpers.ts
git commit -m "feat: load everything a contractor's site shows"
```

---

### Task 6: The breeze design

**Files:**
- Create: `src/modules/sites/site-assets.ts`
- Create: `src/modules/sites/designs/shared.ts`, `designs/breeze.ts`, `designs/breeze.css`, `designs/site.js`, `designs/index.ts`
- Test: `src/modules/sites/designs.test.ts`

**Interfaces:**
- Consumes: `Html`, `html`, `raw` (Task 2); `SiteView`, `buildSiteView` (Task 4); `siteData` (Task 4 fixture).
- Produces:

```ts
// site-assets.ts: files read once at startup from ./designs/
export const SITE_ASSET_FILES = ['breeze.css', 'site.js'] as const // Tasks 11 and 12 add theirs
export type SiteAssetFile = (typeof SITE_ASSET_FILES)[number]
export function assetUrl(file: SiteAssetFile): string // '/api/site/assets/breeze.css?v=<first 10 hex of sha256>'
export function findAsset(file: string): { body: Buffer; contentType: string } | undefined

// designs/shared.ts
export function pageHead(view: SiteView, options: { css: SiteAssetFile; fontsHref: string }): Html
export function brandStyle(view: SiteView): string // '--brand:#1d4ed8;--on-brand:#ffffff;--accent:#0ea5e9;--on-accent:#000000'
export function stars(rating: number): Html // visible stars plus '5 out of 5 stars' for screen readers
export function phoneDock(view: SiteView): Html // the phone Call / Book bar

// designs/breeze.ts
export function renderBreeze(view: SiteView): Html // the whole document, from <!doctype html>

// designs/index.ts
export function renderSite(view: SiteView): string
```

- `pageHead` holds:
  - charset and viewport.
  - `<title>${name} | AC & Heating Repair in ${city}</title>`.
  - meta description = intro, and `theme-color` = brand primary.
  - the favicon link, only when `faviconUrl` is set.
  - Google Fonts preconnect and stylesheet, then the design CSS via `assetUrl`.
  - the inline `document.documentElement.classList.add('js')` line, `site.js` with `defer`, and `<script type="application/ld+json">${raw(view.jsonLd)}</script>`.
- `<html lang="en" style="${brandStyle(view)}">` gives every design its brand variables.
- `renderSite` picks a renderer from `Record<SiteDesign, (view: SiteView) => Html>`. Until Tasks 11 and 12, `clean` and `bold` use `renderBreeze` too.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { siteData } from '../../../test/site-fixture.ts'
import { SITE_DESIGNS } from '../../db/schema.ts'
import { renderSite } from './designs/index.ts'
import { buildSiteView } from './site-view.ts'

const SECTIONS = ['top', 'services', 'how', 'reviews', 'photos', 'about', 'area', 'hours', 'faq', 'book']
const CLAIMS = ['Licensed · AZ ROC #123456', '24/7 emergency service', 'A text when we’re on the way', 'Price approved before work starts']
const page = (overrides: Parameters<typeof siteData>[0] = {}, design = 'breeze' as (typeof SITE_DESIGNS)[number]) =>
  renderSite(buildSiteView(siteData({ ...overrides, site: { design, ...overrides.site } })))

describe.each(SITE_DESIGNS)('%s', (design) => {
  it('is a whole document with the title', () => {
    const html = page({}, design)
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('<title>Desert Breeze Air | AC &amp; Heating Repair in Phoenix</title>')
    expect(html).toContain('<script type="application/ld+json">')
  })

  it('links the phone and the booking page', () => {
    const html = page({}, design)
    expect(html).toContain('href="tel:+16025550142"')
    expect(html).toContain('href="https://desert.localhost/"')
  })

  it('shows every section in order, with its content', () => {
    const html = page({}, design)
    const positions = SECTIONS.map((id) => html.indexOf(`id="${id}"`))
    expect(positions.every((at) => at > 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    for (const text of ['Too hot inside? We’ll bring it back to 76°.', 'AC repair', '$89 diagnostic', 'Free estimate', 'Maria G.', 'Fixed the same day.', 'How do I pay?', 'Family-run since 2009.', 'Mesa', 'Mon–Sat 7 AM–7 PM', ...CLAIMS]) {
      expect(html).toContain(text)
    }
    expect(html).toContain('alt="Technician at a rooftop unit"')
  })

  it('leaves out empty sections and unbacked claims', () => {
    const html = page({ services: [], reviews: [], faqs: [], photos: [], hours: [], tenant: { textingStatus: 'pending' }, site: { about: null, citiesServed: [], licenseNumber: null, emergencyService: false, showPrices: false } }, design)
    for (const id of ['services', 'reviews', 'photos', 'about', 'area', 'hours', 'faq']) expect(html).not.toContain(`id="${id}"`)
    for (const id of ['top', 'how', 'book']) expect(html).toContain(`id="${id}"`)
    for (const claim of CLAIMS) expect(html).not.toContain(claim)
    expect(html).not.toContain('undefined')
  })

  it('shows contractor text as text', () => {
    const review = { id: 'r1', tenantId: 't1', authorName: 'Tom "T" O’Neil', place: null, rating: 4, body: '<img src=x onerror=alert(1)>', sortOrder: 0, createdAt: new Date() }
    const html = page({ reviews: [review] }, design)
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('4 out of 5 stars')
  })
})

it('breeze links its own stylesheet and the shared script', () => {
  const html = page()
  expect(html).toMatch(/href="\/api\/site\/assets\/breeze\.css\?v=[0-9a-f]{10}"/)
  expect(html).toMatch(/src="\/api\/site\/assets\/site\.js\?v=[0-9a-f]{10}"/)
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run src/modules/sites/designs.test.ts`
Expected: FAIL, `./designs/index.ts` does not exist.

- [ ] **Step 3: Port `contractor-site/` into the breeze design**

- `designs/site.js` copies `contractor-site/main.js` unchanged: footer year, phone menu, dock, and the sun-cast fallback, which does nothing without `[data-cast]`.
- `designs/breeze.css` copies `contractor-site/styles.css`. Every field that was `--shade` now uses `var(--brand)`, and every text color on such a field uses `var(--on-brand)`. That includes the `--on-shade-2` secondary text, because no fixed tint is safe on an unknown color. The cast patches become `color-mix(in srgb, var(--brand), var(--on-brand) 8%)`. Marigold stays on Book buttons only, as `DESIGN.md` says.
- `designs/breeze.ts` follows `contractor-site/index.html` section by section and fills it from `SiteView`. It drops the "Outside 112°" and "Inside 76°" readings and the "Sample reviews" line. The trust list becomes `view.claims`. The emergency band shows only when `view.emergency` is true. The nav lists only the sections that are shown. Use `phoneDock`, `stars` and `pageHead` from `shared.ts`.
- `site-assets.ts` reads each file in `SITE_ASSET_FILES` with `readFileSync(new URL(\`./designs/${file}\`, import.meta.url))` at module load. Content types: `.css` is `text/css; charset=utf-8`, `.js` is `text/javascript; charset=utf-8`.

- [ ] **Step 4: Run the test and see it pass**

Run: `npx vitest run src/modules/sites/designs.test.ts`
Expected: PASS. All three design blocks render breeze for now.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
npm run typecheck
npx biome check --write src/modules/sites
git add src/modules/sites
git commit -m "feat: the breeze site design, from the demo contractor's page"
```

---

### Task 7: Public routes

**Files:**
- Create: `src/modules/sites/sites.routes.ts`
- Create: `src/modules/sites/designs/system-pages.ts`
- Modify: `src/modules/sites/sites.service.ts` (add `renderPublicPage`, `getPhoto`)
- Modify: `src/modules/sites/sites.queries.ts` (add `findPhotoData`)
- Modify: `src/app.ts`
- Test: `src/modules/sites/sites-public.test.ts`

**Interfaces:**
- Consumes: `parseSiteHost` (Task 3), `loadPublicSite` (Task 5), `renderSite`, `findAsset` (Task 6), `findTenantByHost` (`branding.queries.ts`).
- Produces:
  - `siteHostRoutes: Router`. It's mounted in `app.ts` right after `pinoHttp(...)`, before `widgetRoutes` and `cors`.
  - `sitesRoutes: Router`. It's added to the `/api` list in `app.ts`, and later tasks add the editing routes to it.
  - `renderPublicPage(slug: string): Promise<string | null>`. It returns null when the tenant is missing or `suspended`, there's no row, or `publishedAt` is null.
  - `getPhoto(photoId: string): Promise<{ contentType: string; data: Buffer }>`, with a 404 of `Photo not found.`.
  - `findPhotoData(id: string)`. Like branding's `findAsset`, it isn't tenant-scoped: photos are public by random id.
  - `NOT_FOUND_PAGE` and `ERROR_PAGE`: small standalone HTML strings with no contractor details. The 404 says `This page isn’t here.`. The 500 says `Something went wrong. Try again in a minute.`.

- [ ] **Step 1: Write the failing test**

```ts
import { eq } from 'drizzle-orm'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createShop, createSite, resetDb } from '../../../test/helpers.ts'
import { createApp } from '../../app.ts'
import { db } from '../../db/client.ts'
import { sitePhotos, tenants } from '../../db/schema.ts'
import { assetUrl } from './site-assets.ts'
import * as queries from './sites.queries.ts'

const app = createApp()
const HOST = 'desert.site.localhost'
beforeEach(resetDb)

describe('GET / on a site host', () => {
  it('renders a published site', async () => {
    const shop = await createShop('desert')
    await createSite(shop.tenant.id)
    const res = await request(app).get('/').set('Host', HOST).expect(200)
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(res.headers['cache-control']).toBe('no-cache')
    expect(res.text).toContain('Cool again today')
  })

  it.each([
    ['an unknown contractor', 'nobody.site.localhost', async (_tenantId: string) => {}],
    ['a contractor with no site', HOST, async (_tenantId: string) => {}],
    ['an unpublished site', HOST, async (tenantId: string) => { await createSite(tenantId, { publishedAt: null }) }],
    ['a suspended contractor', HOST, async (tenantId: string) => {
      await createSite(tenantId)
      await db.update(tenants).set({ status: 'suspended' }).where(eq(tenants.id, tenantId))
    }],
  ])('is a plain 404 for %s', async (_name, host, arrange) => {
    const shop = await createShop('desert')
    await arrange(shop.tenant.id)
    const res = await request(app).get('/').set('Host', host).expect(404)
    expect(res.text).toContain('This page isn’t here.')
    expect(res.text).not.toContain('desert HVAC')
  })

  it('is a 404 for any other path', async () => {
    const shop = await createShop('desert')
    await createSite(shop.tenant.id)
    await request(app).get('/about').set('Host', HOST).expect(404)
  })

  it('is a bare 500 page when the database fails', async () => {
    const shop = await createShop('desert')
    await createSite(shop.tenant.id)
    vi.spyOn(queries, 'findSite').mockRejectedValueOnce(new Error('database down'))
    const res = await request(app).get('/').set('Host', HOST).expect(500)
    expect(res.text).toContain('Something went wrong. Try again in a minute.')
    expect(res.text).not.toContain('database down')
  })

  it('leaves the API and other hosts alone', async () => {
    await request(app).get('/health').set('Host', 'desert.localhost').expect(200, { ok: true })
    await request(app).get(assetUrl('breeze.css')).set('Host', HOST).expect(200)
  })
})

describe('site assets and photos', () => {
  it('serves a stylesheet for a year', async () => {
    const res = await request(app).get(assetUrl('breeze.css')).expect(200)
    expect(res.headers['content-type']).toBe('text/css; charset=utf-8')
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable')
    await request(app).get('/api/site/assets/nope.css').expect(404)
  })

  it('serves a photo to anyone', async () => {
    const shop = await createShop('desert')
    const data = Buffer.from([0xff, 0xd8, 0xff, 0x01])
    const [photo] = await db.insert(sitePhotos).values({ tenantId: shop.tenant.id, kind: 'work', contentType: 'image/jpeg', data, altText: 'Van', createdBy: shop.office.id }).returning()
    const res = await request(app).get(`/api/site/photos/${photo.id}`).expect(200)
    expect(res.headers['content-type']).toBe('image/jpeg')
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(Buffer.compare(res.body, data)).toBe(0)
    await request(app).get('/api/site/photos/00000000-0000-4000-8000-000000000009').expect(404)
    await request(app).get('/api/site/photos/abc').expect(400)
  })
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run src/modules/sites/sites-public.test.ts`
Expected: FAIL, `./sites.routes.ts` is missing, so the site host gets the JSON 404.

- [ ] **Step 3: Implement the routes and mount them**

- The `siteHostRoutes` middleware calls `next()` when `parseSiteHost(req.hostname, env.APP_DOMAIN)` is null or `req.path` starts with `/api/`.
- A path other than `GET /` or `HEAD /` gets the 404 page.
- Otherwise it calls `renderPublicPage(slug)` inside `try`/`catch`. The catch runs `logger.error({ err, requestId: req.id }, 'Site page failed')` and sends `ERROR_PAGE` with status 500.
- The 404 and 500 pages are sent with `Cache-Control: no-store`. The site page is sent with `no-cache`.
- On `sitesRoutes`, the asset route answers 404 through `HttpError` for an unknown file. The photo route parses `photoId` with `z.uuid()`, so `abc` gets a 400.

- [ ] **Step 4: Run the test and see it pass**

Run: `npx vitest run src/modules/sites/sites-public.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole suite, then typecheck, lint and commit**

Run: `npm test`. Expected: every test passes, so the host gate breaks no existing route.

```bash
npm run typecheck
npx biome check --write src/modules/sites src/app.ts
git add src/modules/sites src/app.ts
git commit -m "feat: serve a contractor's published site on its own host"
```

---

### Task 8: Editing API: content, publish, preview

**Files:**
- Create: `src/modules/sites/sites.schemas.ts`
- Modify: `src/modules/sites/sites.service.ts`, `sites.queries.ts`, `sites.routes.ts`
- Test: `src/modules/sites/sites-edit.test.ts`

**Interfaces:**
- Consumes: `siteUrl` (Task 3), `buildSiteView` (Task 4), `loadPublicSite` (Task 5), `renderSite` (Task 6), `UsState` (`lib/fields.ts`), `tenantOf` (`booking.service.ts`), `audit.insertUserAction`.
- Produces:

```ts
// sites.schemas.ts
export const SiteInput // design, headline, intro, about (blank → null), licenseNumber (blank → null),
                       // city, region (UsState), citiesServed, emergencyService, showPrices; limits from Global Constraints
export type SiteInput = z.infer<typeof SiteInput>

// sites.service.ts
export type SiteEditor = {
  saved: boolean
  liveUrl: string // siteUrl(slug)
  publishedAt: Date | null
  site: SiteInput
  reviews: { id: string; authorName: string; place: string | null; rating: number; body: string }[]
  faqs: { id: string; question: string; answer: string }[]
  photos: { id: string; kind: SitePhotoKind; altText: string; url: string }[] // url '/site/photos/<id>', relative to the API like branding's logoUrl
}
export function getSiteEditor(tenantId: string): Promise<SiteEditor>
export function saveSite(user: SessionUser, input: SiteInput): Promise<SiteEditor>
export function publishSite(user: SessionUser): Promise<SiteEditor>
export function unpublishSite(user: SessionUser): Promise<SiteEditor>
export function renderPreview(tenantId: string): Promise<string>
```

- With no row, `getSiteEditor` returns `saved: false` and this prefill: design `breeze`, headline `AC and heating repair, booked online`, intro `Book a visit online in about two minutes, or give us a call.`, about and license `null`, city and region `''`, no cities, emergency `false`, showPrices `true`.
- `saveSite` upserts with `onConflictDoUpdate` on `tenant_id` and sets `updatedAt`.
- `publishSite` keeps an earlier `publishedAt`. It refuses with `site_not_saved` when there's no row and with `site_incomplete` when there's no active service.
- `unpublishSite` sets `publishedAt` to null and is a no-op without a row.
- `renderPreview` refuses with `site_not_saved` when there's no row. The preview route sends HTML with `Cache-Control: no-store`.
- Routes: `GET /site`, `PUT /site`, `POST /site/publish`, `POST /site/unpublish`, `GET /site/preview`.

- [ ] **Step 1: Write the failing test**

```ts
import { and, eq } from 'drizzle-orm'
import request from 'supertest'
import { beforeEach, expect, it } from 'vitest'
import { createShop, createTenant, createUser, resetDb, signIn, signInTechnician } from '../../../test/helpers.ts'
import { createApp } from '../../app.ts'
import { db } from '../../db/client.ts'
import { auditEvents } from '../../db/schema.ts'
import { siteUrl } from '../../lib/tenant-url.ts'

const app = createApp()
beforeEach(resetDb)

const basics = { design: 'clean', headline: 'Cool again today', intro: 'AC repair across Phoenix.', about: '', licenseNumber: ' AZ ROC #123456 ', city: 'Phoenix', region: 'az', citiesServed: ['Phoenix', 'Mesa'], emergencyService: true, showPrices: false }

it('offers a prefilled form before the first save', async () => {
  const shop = await createShop('desert')
  const res = await request(app).get('/api/site').set('Cookie', shop.cookie).expect(200)
  expect(res.body).toMatchObject({ saved: false, liveUrl: siteUrl('desert'), publishedAt: null, reviews: [], faqs: [], photos: [] })
  expect(res.body.site).toMatchObject({ design: 'breeze', headline: 'AC and heating repair, booked online', city: '', showPrices: true })
})

it('saves the basics and records who did', async () => {
  const shop = await createShop('desert')
  const res = await request(app).put('/api/site').set('Cookie', shop.cookie).send(basics).expect(200)
  expect(res.body.saved).toBe(true)
  expect(res.body.site).toEqual({ ...basics, about: null, licenseNumber: 'AZ ROC #123456', region: 'AZ' })
  const events = await db.select().from(auditEvents).where(and(eq(auditEvents.tenantId, shop.tenant.id), eq(auditEvents.action, 'site.updated')))
  expect(events).toHaveLength(1)
})

it('marks the fields it refuses', async () => {
  const shop = await createShop('desert')
  const res = await request(app).put('/api/site').set('Cookie', shop.cookie).send({ ...basics, headline: ' ', region: 'Arizona' }).expect(400)
  expect(Object.keys(res.body.error.details)).toEqual(expect.arrayContaining(['headline', 'region']))
})

it('publishes only a saved site with a service, then shows it on its host', async () => {
  const empty = await createTenant('empty')
  const owner = await createUser('owner', empty.id)
  const ownerCookie = await signIn(owner.email)
  await request(app).post('/api/site/publish').set('Cookie', ownerCookie).expect(409).expect((res) => expect(res.body.error.code).toBe('site_not_saved'))
  await request(app).put('/api/site').set('Cookie', ownerCookie).send(basics).expect(200)
  await request(app).post('/api/site/publish').set('Cookie', ownerCookie).expect(409).expect((res) => expect(res.body.error.code).toBe('site_incomplete'))

  const shop = await createShop('desert')
  await request(app).put('/api/site').set('Cookie', shop.cookie).send(basics).expect(200)
  const published = await request(app).post('/api/site/publish').set('Cookie', shop.cookie).expect(200)
  expect(published.body.publishedAt).toEqual(expect.any(String))
  await request(app).get('/').set('Host', 'desert.site.localhost').expect(200)

  await request(app).post('/api/site/unpublish').set('Cookie', shop.cookie).expect(200)
  await request(app).get('/').set('Host', 'desert.site.localhost').expect(404)
})

it('previews an unpublished site for staff', async () => {
  const shop = await createShop('desert')
  await request(app).get('/api/site/preview').set('Cookie', shop.cookie).expect(409)
  await request(app).put('/api/site').set('Cookie', shop.cookie).send(basics).expect(200)
  const res = await request(app).get('/api/site/preview').set('Cookie', shop.cookie).expect(200)
  expect(res.headers['content-type']).toBe('text/html; charset=utf-8')
  expect(res.text).toContain('Cool again today')
})

it('keeps each contractor to their own site', async () => {
  const desert = await createShop('desert')
  const other = await createShop('other')
  await request(app).put('/api/site').set('Cookie', desert.cookie).send(basics).expect(200)
  const res = await request(app).get('/api/site').set('Cookie', other.cookie).expect(200)
  expect(res.body.saved).toBe(false)
})

it('is for owner and office only', async () => {
  const shop = await createShop('desert')
  await request(app).get('/api/site').expect(401)
  const technicianCookie = await signInTechnician(shop.mike)
  await request(app).get('/api/site').set('Cookie', technicianCookie).expect(403)
})
```

(`createShop` technicians have no email, so they sign in with `signInTechnician`, not `signIn`.)

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run src/modules/sites/sites-edit.test.ts`
Expected: FAIL, `/api/site` answers the JSON "Route not found".

- [ ] **Step 3: Implement the schema, service functions and routes**

Blank optional text uses one local helper in `sites.schemas.ts`, `optionalText(max: number, message: string)`. It trims and turns blank into `null`, following `OptionalPhone` in `lib/fields.ts`. City entries are trimmed, blanks dropped, and duplicates kept out case-insensitively before the 30 limit applies.

- [ ] **Step 4: Run the test and see it pass**

Run: `npx vitest run src/modules/sites/sites-edit.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
npm run typecheck
npx biome check --write src/modules/sites
git add src/modules/sites
git commit -m "feat: contractors edit, preview and publish their site"
```

---

### Task 9: Reviews and FAQ API

**Files:**
- Create: `src/modules/sites/site-lists.service.ts`
- Modify: `src/modules/sites/sites.schemas.ts`, `sites.queries.ts`, `sites.routes.ts`
- Test: `src/modules/sites/site-lists.test.ts`

**Interfaces:**
- Consumes: `getSiteEditor`, `SiteEditor` (Task 8).
- Produces:
  - Schemas: `ReviewInput` (`authorName`, `place` blank → null, `rating` an int 1–5, `body`), `FaqInput` (`question`, `answer`), `OrderInput` (`{ ids: z.array(z.uuid()).max(200) }`), `ReviewParams` (`{ reviewId: z.uuid() }`), `FaqParams` (`{ faqId: z.uuid() }`).
  - Service functions, each returning `Promise<SiteEditor>`: `addReview(user, input)`, `updateReview(user, reviewId, input)`, `deleteReview(user, reviewId)`, `reorderReviews(user, ids)`, `addFaq`, `updateFaq`, `deleteFaq`, `reorderFaqs`.
  - Routes: `POST /site/reviews`, `PUT /site/reviews/order` (registered **before** `PUT /site/reviews/:reviewId`), `PUT /site/reviews/:reviewId`, `DELETE /site/reviews/:reviewId`, and the same four under `/site/faqs` with `:faqId`.
- A new item goes last: `sort_order` = current max + 1, or 0 when the list is empty.
- Update and delete match `tenant_id` and `id` together. Zero rows means 404 `Review not found.` or `Question not found.`.
- Reorder runs in one transaction. It locks the tenant's ids (`select … for update`) and refuses with `list_changed` unless `ids` holds each existing id exactly once. This follows `catalog.service.ts` `reorder`.

- [ ] **Step 1: Write the failing test**

```ts
import request from 'supertest'
import { beforeEach, expect, it } from 'vitest'
import { createShop, resetDb } from '../../../test/helpers.ts'
import { createApp } from '../../app.ts'

const app = createApp()
beforeEach(resetDb)

const review = (body: string) => ({ authorName: 'Maria G.', place: 'Mesa', rating: 5, body })

it('adds reviews in order, edits and deletes them', async () => {
  const shop = await createShop('desert')
  const put = (path: string, body: object) => request(app).put(path).set('Cookie', shop.cookie).send(body)
  await request(app).post('/api/site/reviews').set('Cookie', shop.cookie).send(review('First')).expect(200)
  const added = await request(app).post('/api/site/reviews').set('Cookie', shop.cookie).send({ ...review('Second'), place: '' }).expect(200)
  expect(added.body.reviews.map((r: { body: string }) => r.body)).toEqual(['First', 'Second'])
  expect(added.body.reviews[1].place).toBeNull()

  const [first, second] = added.body.reviews
  const edited = await put(`/api/site/reviews/${first.id}`, review('First, edited')).expect(200)
  expect(edited.body.reviews[0].body).toBe('First, edited')

  const reordered = await put('/api/site/reviews/order', { ids: [second.id, first.id] }).expect(200)
  expect(reordered.body.reviews.map((r: { id: string }) => r.id)).toEqual([second.id, first.id])

  const deleted = await request(app).delete(`/api/site/reviews/${second.id}`).set('Cookie', shop.cookie).expect(200)
  expect(deleted.body.reviews).toHaveLength(1)
})

it('refuses an order made before another tab deleted a review', async () => {
  const shop = await createShop('desert')
  await request(app).post('/api/site/reviews').set('Cookie', shop.cookie).send(review('A')).expect(200)
  const res = await request(app).post('/api/site/reviews').set('Cookie', shop.cookie).send(review('B')).expect(200)
  const [a, b] = res.body.reviews
  await request(app).delete(`/api/site/reviews/${b.id}`).set('Cookie', shop.cookie).expect(200)
  const stale = await request(app).put('/api/site/reviews/order').set('Cookie', shop.cookie).send({ ids: [b.id, a.id] }).expect(409)
  expect(stale.body.error).toEqual({ code: 'list_changed', message: 'Your list changed since this page loaded. Refresh and try again.' })
})

it('refuses a rating of 6', async () => {
  const shop = await createShop('desert')
  await request(app).post('/api/site/reviews').set('Cookie', shop.cookie).send({ ...review('x'), rating: 6 }).expect(400)
})

it('keeps each contractor to their own reviews and questions', async () => {
  const desert = await createShop('desert')
  const other = await createShop('other')
  const r = await request(app).post('/api/site/reviews').set('Cookie', desert.cookie).send(review('Mine')).expect(200)
  const f = await request(app).post('/api/site/faqs').set('Cookie', desert.cookie).send({ question: 'How do I pay?', answer: 'Card.' }).expect(200)
  await request(app).put(`/api/site/reviews/${r.body.reviews[0].id}`).set('Cookie', other.cookie).send(review('Theirs')).expect(404)
  await request(app).delete(`/api/site/faqs/${f.body.faqs[0].id}`).set('Cookie', other.cookie).expect(404)
})

it('handles questions like reviews', async () => {
  const shop = await createShop('desert')
  const q = (question: string) => request(app).post('/api/site/faqs').set('Cookie', shop.cookie).send({ question, answer: 'Yes.' }).expect(200)
  await q('One?')
  const res = await q('Two?')
  const [one, two] = res.body.faqs
  const reordered = await request(app).put('/api/site/faqs/order').set('Cookie', shop.cookie).send({ ids: [two.id, one.id] }).expect(200)
  expect(reordered.body.faqs.map((f: { question: string }) => f.question)).toEqual(['Two?', 'One?'])
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run src/modules/sites/site-lists.test.ts`
Expected: FAIL, 404 "Route not found".

- [ ] **Step 3: Implement the schemas, queries, `site-lists.service.ts` and routes**

Reviews and FAQs get their own plain functions, with no shared generic, so each reads on its own. Each change writes its audit action from Global Constraints.

- [ ] **Step 4: Run the test and see it pass**

Run: `npx vitest run src/modules/sites/site-lists.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
npm run typecheck
npx biome check --write src/modules/sites
git add src/modules/sites
git commit -m "feat: contractors add and order their site's reviews and questions"
```

---

### Task 10: Photos API

**Files:**
- Create: `src/modules/sites/site-photos.service.ts`
- Modify: `src/modules/sites/sites.schemas.ts`, `sites.queries.ts`, `sites.routes.ts`
- Test: `src/modules/sites/site-photos.test.ts`

**Interfaces:**
- Consumes: `photoTypeOf` (`lib/image-type.ts`), `getSiteEditor` (Task 8), `SITE_PHOTO_*` constants (Task 1).
- Produces:
  - `PhotoQuery`: `{ kind: z.enum(SITE_PHOTO_KINDS), alt }`, where alt is trimmed, 1–200 characters, with the message `Describe the photo for people who can’t see it`.
  - `PhotoParams`: `{ photoId: z.uuid() }`.
  - `addPhoto(user: SessionUser, query: PhotoQuery, bytes: Buffer): Promise<SiteEditor>`.
  - `deletePhoto(user: SessionUser, photoId: string): Promise<SiteEditor>`.
  - Routes: `POST /site/photos?kind=hero|work&alt=…`, whose body is the raw image, parsed with `express.raw({ type: () => true, limit: '2mb' })` so an oversized photo gets this module's message rather than Express's 413. Plus `DELETE /site/photos/:photoId`.
- `addPhoto` refuses with `bad_photo` unless `photoTypeOf(bytes)` is `image/jpeg` or `image/webp` and the size is 1 to `SITE_PHOTO_MAX_BYTES` bytes.
- A hero upload deletes the old hero and inserts the new one in one transaction.
- A work upload refuses with `too_many_photos` when 12 already exist, and otherwise uses `sort_order` = the current count.

- [ ] **Step 1: Write the failing test**

```ts
import request from 'supertest'
import { beforeEach, expect, it } from 'vitest'
import { createShop, resetDb, type Shop } from '../../../test/helpers.ts'
import { createApp } from '../../app.ts'

const app = createApp()
beforeEach(resetDb)

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(64, 1)])
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)])
const upload = (shop: Shop, kind: string, body: Buffer, alt = 'Our van') =>
  request(app).post(`/api/site/photos?kind=${kind}&alt=${encodeURIComponent(alt)}`).set('Cookie', shop.cookie).set('Content-Type', 'image/jpeg').send(body)

it('adds a work photo anyone can then load', async () => {
  const shop = await createShop('desert')
  const res = await upload(shop, 'work', JPEG).expect(200)
  expect(res.body.photos).toEqual([{ id: expect.any(String), kind: 'work', altText: 'Our van', url: `/site/photos/${res.body.photos[0].id}` }])
  await request(app).get(`/api${res.body.photos[0].url}`).expect(200)
})

it('keeps one hero photo', async () => {
  const shop = await createShop('desert')
  const first = await upload(shop, 'hero', JPEG).expect(200)
  const second = await upload(shop, 'hero', JPEG, 'New van').expect(200)
  expect(second.body.photos).toHaveLength(1)
  expect(second.body.photos[0].altText).toBe('New van')
  await request(app).get(`/api/site/photos/${first.body.photos[0].id}`).expect(404)
})

it.each([
  ['a PNG', PNG],
  ['a photo over 1 MB', Buffer.concat([JPEG, Buffer.alloc(1_048_576)])],
  ['an empty body', Buffer.alloc(0)],
])('refuses %s', async (_name, body) => {
  const shop = await createShop('desert')
  const res = await upload(shop, 'work', body).expect(400)
  expect(res.body.error).toEqual({ code: 'bad_photo', message: 'Photos must be JPEG or WebP, up to 1 MB.' })
})

it('refuses a photo with no description', async () => {
  const shop = await createShop('desert')
  await upload(shop, 'work', JPEG, ' ').expect(400)
})

it('stops at 12 work photos', async () => {
  const shop = await createShop('desert')
  for (let i = 0; i < 12; i++) await upload(shop, 'work', JPEG).expect(200)
  const res = await upload(shop, 'work', JPEG).expect(409)
  expect(res.body.error.code).toBe('too_many_photos')
})

it('deletes only the contractor’s own photo', async () => {
  const desert = await createShop('desert')
  const other = await createShop('other')
  const res = await upload(desert, 'work', JPEG).expect(200)
  const id = res.body.photos[0].id
  await request(app).delete(`/api/site/photos/${id}`).set('Cookie', other.cookie).expect(404)
  const deleted = await request(app).delete(`/api/site/photos/${id}`).set('Cookie', desert.cookie).expect(200)
  expect(deleted.body.photos).toEqual([])
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run src/modules/sites/site-photos.test.ts`
Expected: FAIL, 404 "Route not found".

- [ ] **Step 3: Implement the schemas, queries, `site-photos.service.ts` and routes**

With an empty body, `express.raw` leaves `req.body` as something other than a Buffer. The route passes `Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)`, so the size check refuses it with `bad_photo`.

- [ ] **Step 4: Run the test and see it pass**

Run: `npx vitest run src/modules/sites/site-photos.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
npm run typecheck
npx biome check --write src/modules/sites
git add src/modules/sites
git commit -m "feat: contractors upload a hero photo and work photos"
```

---

### Task 11: The clean design

**Files:**
- Create: `src/modules/sites/designs/clean.ts`, `designs/clean.css`
- Modify: `src/modules/sites/site-assets.ts` (add `'clean.css'`), `designs/index.ts` (`clean: renderClean`)
- Test: `src/modules/sites/designs.test.ts`

**Interfaces:**
- Consumes: `pageHead`, `brandStyle`, `stars`, `phoneDock` (Task 6).
- Produces: `renderClean(view: SiteView): Html`.

Brief (spec, "Designs"): light and photo-led, built around the hero photo, and suited to any region. It must still look finished with no hero photo. The brand color is used for accents and Book buttons, with `--on-brand` text. Flat fields, Google Fonts only, WCAG 2.2 AA, tap targets of at least 48 px, the fixed Call / Book bar on phones, and the section ids from Global Constraints. Use the `frontend-design:frontend-design` skill for the visual direction, and keep it clearly different from breeze.

- [ ] **Step 1: Add the failing test**

```ts
it('clean links its own stylesheet', () => {
  expect(page({}, 'clean')).toMatch(/href="\/api\/site\/assets\/clean\.css\?v=[0-9a-f]{10}"/)
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run src/modules/sites/designs.test.ts`
Expected: FAIL. `clean` still renders breeze.

- [ ] **Step 3: Build `clean.ts` and `clean.css`, then register them**

- [ ] **Step 4: Run the test and see it pass**

Run: `npx vitest run src/modules/sites/designs.test.ts`
Expected: PASS. The shared `describe.each` blocks now check clean's real markup.

- [ ] **Step 5: Look at it**

With `npm run dev` and Desert seeded (Task 13 can come first if more convenient), set `update sites set design = 'clean'` for Desert. Open `http://desert.site.localhost:3000/` in headless Edge at 375 px and 1280 px. Check the layout with and without a hero photo. Set the design back afterward.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
npm run typecheck
npx biome check --write src/modules/sites
git add src/modules/sites
git commit -m "feat: the clean site design"
```

---

### Task 12: The bold design

Same shape as Task 11, with `bold.ts`, `bold.css`, `renderBold`, `'bold.css'` and the test `it('bold links its own stylesheet', …)`.

Brief: dark and high-contrast, with a large phone number and the emergency band near the top, for shops that live on urgent calls. With `emergency` false, the band is gone and the phone number still leads. The brand color fills big fields with `--on-brand` text. Same rules as clean.

- [ ] **Step 1: Add the failing test.** **Step 2: See it fail.** **Step 3: Build and register.** **Step 4: See it pass.** **Step 5: Look at it at 375 and 1280 px.**
- [ ] **Step 6: Typecheck, lint, commit:** `git commit -m "feat: the bold site design"`

---

### Task 13: Seed Desert's site and document the hosting

**Files:**
- Modify: `src/db/seed.ts`
- Modify: `README.md` (relay-api: running locally, and "Deploying on Render")

**Interfaces:**
- Consumes: `sites`, `siteReviews`, `siteFaqs` (Task 1).

- [ ] **Step 1: Seed the site**

After `seedDispatch(...)`, insert Desert's `sites` row:
- design `breeze`, `publishedAt: new Date()`.
- headline `Too hot inside? We’ll bring it back to 76°.`.
- the intro, from the `hero-sub` paragraph in `contractor-site/index.html`.
- city `Phoenix`, region `AZ`, and `citiesServed` `['Phoenix', 'Scottsdale', 'Tempe', 'Mesa', 'Chandler', 'Gilbert', 'Glendale', 'Peoria']`.
- `emergencyService: true`, `licenseNumber: null` (the demo has no real license).

Copy the three reviews and the FAQ from `contractor-site/index.html` (the `#reviews` and `#faq` sections). Add ` (sample)` to each review's author name so the page still says they aren't real. Update the file's top comment and the `contactPhone` comment, which mention `../contractor-site`, to point at `http://desert.site.localhost:3000/`.

- [ ] **Step 2: Run the seed and open the site**

Run: `npm run db:seed`, then `npm run dev`. Open `http://desert.site.localhost:3000/`.
Expected: the breeze page with Desert's content, three sample reviews, the FAQ, services and hours, and no "Outside 112°" reading.

- [ ] **Step 3: Document it in the README**

- In the local section, add the demo site address.
- Under "Deploying on Render", add: give the relay-api web service the custom domain `*.site.garified.com`, add the DNS records Render shows (the wildcard CNAME and the `_acme-challenge` record for the certificate), and note that no step is needed per contractor.

- [ ] **Step 4: Run all tests, lint, commit**

```bash
npm test
npx biome check --write src/db/seed.ts README.md
git add src/db/seed.ts README.md
git commit -m "feat: seed the demo contractor's website"
```

---

### Task 14 (relay-web): Website page with basics, design, publish and preview

**Files** (relay-web):
- Create: `src/features/site/api.ts`, `src/features/site/order.ts`, `src/features/site/cities.ts`
- Create: `src/features/site/status-card.tsx`, `basics-form.tsx`, `design-picker.tsx`, `site-preview.tsx`
- Create: `src/routes/website.tsx`
- Create: `public/site-designs/breeze.png`, `clean.png`, `bold.png`
- Modify: `src/router.tsx` (`{ path: '/website', element: <WebsitePage /> }` in the staff block), `src/components/sidebar-links.ts` (`{ to: '/website', label: 'Website', icon: Globe }` after Booking settings)
- Test: `src/features/site/order.test.ts`, `src/features/site/cities.test.ts`

**Interfaces:**
- Consumes: the `/api/site` routes (Tasks 8–10), `api` (`lib/api.ts`), `env.VITE_API_URL`, `shrinkPhoto` (`lib/photo.ts`), `copyText` (`features/settings/copy.ts`), `errorMessage` (`lib/errors.ts`).
- Produces in `features/site/api.ts`:
  - Zod `SiteEditor`, mirroring the API's `SiteEditor`, with `publishedAt` as `string | null` and `design` as `'breeze' | 'clean' | 'bold'`, plus the types `SiteEditor`, `SiteFields`, `Review`, `Faq` and `SitePhoto`.
  - Hooks:
    - `useSiteEditor()` (query key `['site']`)
    - `useSaveSite()` (`SiteFields`)
    - `usePublishSite()`, `useUnpublishSite()`
    - `useAddReview()`, `useUpdateReview()` (`{ id } & ReviewInput`), `useDeleteReview()` (id), `useReorderReviews()` (ids)
    - the same four for FAQs
    - `useAddPhoto()` (`{ kind, altText, file: File }`, which runs `shrinkPhoto(file)` and then POSTs the blob to `/site/photos?kind=…&alt=…`)
    - `useDeletePhoto()` (id)

    Every mutation replaces `['site']` with the editor it gets back.
  - `previewUrl(version: number): string` returns `` `${env.VITE_API_URL}/site/preview?v=${version}` ``.
- `order.ts`: `moveId(ids: string[], id: string, step: -1 | 1): string[] | null`, which is null at either end or when the id is unknown.
- `cities.ts`: `parseCities(text: string): string[]` splits on commas and new lines, trims, drops blanks, and drops later case-insensitive duplicates. `formatCities(cities: string[]): string` joins with `', '`.

- [ ] **Step 1: Write the failing tests**

```ts
// order.test.ts
import { expect, it } from 'vitest'
import { moveId } from './order'

it('moves an id up or down one place', () => {
  expect(moveId(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c'])
  expect(moveId(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b'])
})

it('is null at either end or for an unknown id', () => {
  expect(moveId(['a', 'b'], 'a', -1)).toBeNull()
  expect(moveId(['a', 'b'], 'b', 1)).toBeNull()
  expect(moveId(['a', 'b'], 'z', 1)).toBeNull()
})

// cities.test.ts
import { expect, it } from 'vitest'
import { formatCities, parseCities } from './cities'

it('reads cities typed with commas or on separate lines', () => {
  expect(parseCities('Phoenix, Mesa\n tempe ,, mesa\n')).toEqual(['Phoenix', 'Mesa', 'tempe'])
  expect(formatCities(['Phoenix', 'Mesa'])).toBe('Phoenix, Mesa')
})
```

- [ ] **Step 2: Run them and see them fail**

Run (relay-web): `npx vitest run src/features/site`
Expected: FAIL, the modules don't exist.

- [ ] **Step 3: Implement `order.ts`, `cities.ts` and `api.ts`**

- [ ] **Step 4: Run them and see them pass**

Run: `npx vitest run src/features/site`
Expected: PASS.

- [ ] **Step 5: Build the page**

`WebsitePage` is a `StaffPage` titled "Website".
- **Desktop layout (lg and up):** two columns. The editor is on the left and a sticky preview on the right.
- **Phones:** a Preview button opens `previewUrl(...)` in a new tab. The session cookie goes along, because the app and the API are on the same site.
- **Loading and errors:** follow `routes/settings.tsx`, with the loading text and a "Try again" block.
- **StatusCard:**
  - an Off or Live badge.
  - `liveUrl` with a Copy button (`copyText`) and an Open link (`target="_blank" rel="noreferrer"`).
  - Publish when `publishedAt` is null, Unpublish otherwise.
  - Publish is disabled with the hint "Save the basics first" while `saved` is false.
  - API errors appear in a toast using `errorMessage`.
- **BasicsForm:** one form with one Save.
  - **Design picker:** three radio cards, each showing `/site-designs/<design>.png` and a one-line description from the spec.
  - **Text fields:** headline, intro, about, license number, city, region, cities served (a textarea using `parseCities` / `formatCities`), and the emergency and show-prices checkboxes.
  - **Errors:** show field errors from `ApiError.details` next to their fields, as other forms do.
  - **Reused data:** three read-only lines link to `/services` ("Services and prices come from Services") and `/schedule` ("Hours come from Schedule"), and state "Logo and colors are set by Relay."
- **SitePreview:** an `<iframe title="Website preview">` of `previewUrl(useSiteEditor().dataUpdatedAt)`, so it reloads after each save. It's only shown when `saved`; otherwise it reads "Save the basics to see a preview."

- [ ] **Step 6: Make the design thumbnails**

With relay-api running on the seeded data, take three screenshots in headless Edge at 1280×800, one per design. Switch designs with psql (`update sites set design = '<design>'` for Desert), and restore `breeze` after. Save them as `public/site-designs/<design>.png`, each under 150 KB.

- [ ] **Step 7: Check it in the browser**

Sign in as `office@desert.test` at `http://desert.localhost:5173/sign-in/contractor` and open **Website**. Change the headline and Save: the preview updates. Unpublish: `http://desert.site.localhost:3000/` gives 404. Publish: it's back. Try at 375 px too.

- [ ] **Step 8: Typecheck, lint, commit**

```bash
npm run typecheck
npm test
npx biome check --write src/features/site src/routes/website.tsx src/router.tsx src/components/sidebar-links.ts
git add src/features/site src/routes/website.tsx src/router.tsx src/components/sidebar-links.ts public/site-designs
git commit -m "feat: website page to edit, preview and publish the site"
```

---

### Task 15 (relay-web): Reviews, FAQ and photos editors

**Files** (relay-web):
- Create: `src/features/site/reviews-editor.tsx`, `faqs-editor.tsx`, `photos-editor.tsx`
- Modify: `src/routes/website.tsx` (add the three under BasicsForm)

**Interfaces:**
- Consumes: the hooks and `moveId` from Task 14, `ConfirmDialog` (`components/confirm-dialog.tsx`), `PhotoError` (`lib/photo.ts`).

- [ ] **Step 1: Build the editors**

- **ReviewsEditor:**
  - **Rows:** each shows author, place, stars and body, plus up and down buttons. A button calls `moveId`, then `useReorderReviews`, and is disabled at the ends.
  - **Edit:** a dialog with author, place, a rating select (1–5) and body.
  - **Delete:** asks first through `ConfirmDialog`.
  - **Add review:** opens the same dialog.
  - **Empty list:** says "No reviews yet. The Reviews section stays hidden until you add one."
- **FaqsEditor:** the same pattern with question and answer.
- **PhotosEditor:**
  - **Hero slot:** a thumbnail (`env.VITE_API_URL + photo.url`) and Replace.
  - **Work grid:** up to 12 photos with Delete. Add is disabled at 12, with "Up to 12 photos".
  - **Adding:** each add picks a file and asks for the required description first. A `PhotoError` or `ApiError` message shows in a toast.

- [ ] **Step 2: Check it in the browser**

Add, edit, reorder and delete a review and a question. Upload a hero and two work photos from a phone-sized JPEG and a PNG; the PNG is turned into a JPEG by `shrinkPhoto`, so it's accepted. Delete one. Each change shows in the preview and on `http://desert.site.localhost:3000/`.

- [ ] **Step 3: Typecheck, lint, commit**

```bash
npm run typecheck
npm test
npx biome check --write src/features/site src/routes/website.tsx
git add src/features/site src/routes/website.tsx
git commit -m "feat: edit the site's reviews, questions and photos"
```

---

### Task 16: Retire contractor-site and final check

**Files:**
- Modify (relay-web): `vite.config.ts` (remove `contractorSite()`, `contractorSiteDir`, `contractorSiteTypes`, and the `fs` import if nothing else uses it), `README.md` (the "Demo website" line)
- Modify (relay-api): `README.md` (the `contractor-site/` line in the folder layout and the "Plain http://localhost:5173" paragraph)
- Delete: `relay/contractor-site/` (only after the user says yes, see Step 3)

- [ ] **Step 1: Remove the dev plugin and update both READMEs**

The READMEs now say the demo contractor's website is at `http://desert.site.localhost:3000/` (relay-api) and is edited on the Website page. Plain `localhost:5173` shows "Contractor not found", as on any unknown host.

- [ ] **Step 2: Run everything**

```bash
# relay-api
npm test && npm run typecheck
# relay-web
npm test && npm run typecheck && npm run build
```

Expected: every test passes, there are no type errors, and the build succeeds.

- [ ] **Step 3: Ask before deleting `contractor-site/`**

`relay/contractor-site/` isn't in either git repository, so deleting it can't be undone with git. Its markup and CSS now live in `designs/breeze.*`, and the copy lives in the seed. Ask the user to confirm, then delete the folder. Leave `contractor-site.zip` alone.

- [ ] **Step 4: Final browser check (headless Edge)**

- Each design at 375 px and 1280 px on `http://desert.site.localhost:3000/`: Call and Book reachable on every screen, the phone bar appears after scrolling past the hero, there's no horizontal scroll, and keyboard focus shows.
- The Website page loop: edit, preview, publish and unpublish, and photos.
- The booking page at `http://desert.localhost:5173/` is unchanged.

- [ ] **Step 5: Lint and commit in both repos**

```bash
# relay-web
npx biome check --write vite.config.ts README.md
git add vite.config.ts README.md
git commit -m "chore: drop the dev server's contractor-site page"
# relay-api
npx biome check --write README.md
git add README.md
git commit -m "docs: the demo contractor's website lives in relay-api now"
```
