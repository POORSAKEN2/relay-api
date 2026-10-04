# Logo and Favicon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The superadmin uploads or removes a contractor's logo and favicon (PNG or SVG). The logo shows on the booking page and in the staff sidebar, and the favicon in the browser tab.

**Architecture:** relay-api stores images in a new append-only `branding_assets` table. `branding_versions` points at them with tenant-scoped foreign keys, and every upload or removal saves a new branding version. A public route serves an asset with a sandbox CSP and immutable caching. relay-web adds upload rows to the admin card, shows the logo in `BookingShell` and `Sidebar`, and swaps the `<link rel="icon">` tags in `AppLayout`.

**Tech Stack:** relay-api: Node 22, Express 5, Drizzle ORM + drizzle-kit, Postgres 18, zod 4, vitest + supertest. relay-web: React, TanStack Query, zod 4, shadcn/ui (Base UI), sonner, vitest (node environment).

**Spec:** `relay-api/docs/superpowers/specs/2026-10-03-branding-logo-favicon-design.md`

## Global Constraints

- There are two repos side by side: `D:\Sen\personal\HVAC\relay-api` and `D:\Sen\personal\HVAC\relay-web`. Each task names its repo. Run commands from that repo's root, in the Bash tool with POSIX syntax (the machine is Windows).
- Branch `feat/branding-assets` in both repos, created from `feat/contractor-lifecycle`. The controller creates the branches; never switch branches.
- relay-web's untracked `src/features/auth/landing.test.ts` is the user's work in progress, and it already fails typecheck, lint and tests. Never edit, format, stage or delete it. Its failures don't count; any other failure does.
- Lint gate in both repos: `npx biome check --line-ending=crlf .`. The working copies use CRLF line endings. Keep files CRLF and never add a BOM.
- Before each commit, in the task's repo: `npm run typecheck`, the lint gate and `npm test` pass. In relay-api, never run two test suites at once, because they share the test database.
- Every commit message ends with exactly `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Add files by path. Do not push.
- Accepted types: `image/png` and `image/svg+xml` (`BRANDING_ASSET_TYPES`). Kinds: `logo` and `favicon` (`BRANDING_ASSET_KINDS`). Limits: `LOGO_MAX_BYTES = 512 * 1024`, `FAVICON_MAX_BYTES = 100 * 1024`. Upload body limit `1mb`.
- Error codes and messages, copied exactly:
  - `400 unsupported_image`: `Use a PNG or SVG file.`
  - `400 image_too_large`: `The logo must be 512 KB or smaller.` / `The favicon must be 100 KB or smaller.`
  - `400 unsafe_svg`: `This SVG has scripts or links in it. Export it again as a plain SVG.`
  - `404 not_found`: `Contractor not found` (upload and remove) / `Image not found` (serving)
- Audit actions: `branding.logo_updated`, `branding.logo_removed`, `branding.favicon_updated`, `branding.favicon_removed`. Entity type `tenant`, entity id the contractor. Data `{ assetId }` on upload and `{}` on removal.
- Headers for the asset route:
  - `Content-Type: <stored type>`
  - `X-Content-Type-Options: nosniff`
  - `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`
  - `Cache-Control: public, max-age=31536000, immutable`
  - `Cross-Origin-Resource-Policy: cross-origin`
- Asset path in API responses: `/branding/assets/<id>`. relay-web puts `env.VITE_API_URL` in front, as it does for `photoUrl`.
- Web toasts: `Logo updated`, `Logo removed`, `Favicon updated`, `Favicon removed`.
- User-facing text uses curly apostrophes (’). Code follows Biome style: 2-space indent, single quotes, no semicolons. Comments only where they explain why.

## Review Focus

1. **SVG with an XML prolog, a BOM or leading whitespace** (`\uFEFF  <?xml …?><svg …>`) is accepted as SVG; a text file that merely mentions `<svg` later in a non-XML body is not. Pinned in Task 1.
2. **A safe SVG using `xmlns:xlink="http://www.w3.org/1999/xlink"` and `href="#id"`** (common from design tools) passes the unsafe check; only real external `href`s are refused. Pinned in Task 1.
3. **Saving colors after uploading a logo keeps the logo**, and uploading a favicon keeps the logo and colors. Carry-over is the easiest thing to break. Pinned in Tasks 2 and 3.
4. **Another contractor's asset id can't be put in a version** (the tenant-scoped FK). Pinned in Task 2.
5. **Switching to a contractor without a favicon puts Relay's icons back exactly**, including `sizes="48x48"` and `type="image/svg+xml"`. Pinned in Task 4.

---

### Task 1: API – recognise PNG and SVG, and refuse unsafe SVG

Repo: relay-api.

**Files:**
- Modify: `src/db/schema.ts` (add the constants only: `BRANDING_ASSET_KINDS`, `BRANDING_ASSET_TYPES`, `LOGO_MAX_BYTES`, `FAVICON_MAX_BYTES`, placed just above `brandingVersions`)
- Modify: `src/lib/image-type.ts`
- Create: `src/lib/image-type.test.ts`

**Interfaces:**
- Produces:
  - `brandingAssetTypeOf(bytes: Buffer): 'image/png' | 'image/svg+xml' | null`
  - `svgText(bytes: Buffer): string | null` (the decoded text when the bytes are an SVG)
  - `isUnsafeSvg(text: string): boolean`
  - the four constants in `schema.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/image-type.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { brandingAssetTypeOf, isUnsafeSvg, photoTypeOf, svgText } from './image-type.ts'

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 1),
])
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'

describe('brandingAssetTypeOf', () => {
  it('recognises a PNG by its signature', () => {
    expect(brandingAssetTypeOf(PNG)).toBe('image/png')
  })

  it.each([
    ['a plain SVG', SVG],
    ['an SVG with an XML prolog', `<?xml version="1.0" encoding="UTF-8"?>\n${SVG}`],
    ['an SVG after a BOM and whitespace', `\uFEFF \n  ${SVG}`],
  ])('recognises %s', (_label, text) => {
    expect(brandingAssetTypeOf(Buffer.from(text))).toBe('image/svg+xml')
  })

  it.each([
    ['a JPEG', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])],
    ['text that only mentions <svg later', Buffer.from('hello <svg></svg>')],
    ['an XML file without an svg element', Buffer.from('<?xml version="1.0"?><note/>')],
    ['bytes that are not UTF-8', Buffer.from([0x3c, 0x73, 0x76, 0x67, 0xff, 0xfe])],
    ['an empty file', Buffer.alloc(0)],
  ])('refuses %s', (_label, bytes) => {
    expect(brandingAssetTypeOf(bytes)).toBeNull()
  })

  it('leaves photo detection as it was', () => {
    expect(photoTypeOf(PNG)).toBe('image/png')
    expect(photoTypeOf(Buffer.from(SVG))).toBeNull()
  })
})

describe('svgText', () => {
  it('gives the text without the BOM and leading whitespace', () => {
    expect(svgText(Buffer.from(`\uFEFF  ${SVG}`))).toBe(SVG)
  })

  it('is null for a PNG', () => {
    expect(svgText(PNG)).toBeNull()
  })
})

describe('isUnsafeSvg', () => {
  it.each([
    ['a script element', '<svg><script>alert(1)</script></svg>'],
    ['a script element in capitals', '<svg><SCRIPT>alert(1)</SCRIPT></svg>'],
    ['a foreignObject', '<svg><foreignObject><div/></foreignObject></svg>'],
    ['an event attribute', '<svg onload="alert(1)"></svg>'],
    ['an event attribute with spaces', '<svg><rect onclick = "x()"/></svg>'],
    ['a javascript: link', '<svg><a href="javascript:alert(1)"><rect/></a></svg>'],
    ['an external href', '<svg><image href="https://evil.test/x.png"/></svg>'],
    ['an external xlink:href', "<svg><use xlink:href='https://evil.test/s.svg#a'/></svg>"],
    ['an empty href', '<svg><use href=""/></svg>'],
  ])('refuses %s', (_label, text) => {
    expect(isUnsafeSvg(text)).toBe(true)
  })

  it.each([
    ['a plain SVG', SVG],
    [
      'an SVG with the xlink namespace and fragment links',
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><defs><path id="a"/></defs><use xlink:href="#a"/><use href="#a"/></svg>',
    ],
    ['an embedded data image', '<svg><image href="data:image/png;base64,iVBORw0KGgo="/></svg>'],
    ['a font attribute', '<svg><text font-family="Inter" font-size="4">Hi</text></svg>'],
  ])('accepts %s', (_label, text) => {
    expect(isUnsafeSvg(text)).toBe(false)
  })
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npm test -- src/lib/image-type.test.ts`
Expected: FAIL, because `brandingAssetTypeOf`, `svgText` and `isUnsafeSvg` are not exported.

- [ ] **Step 3: Add the constants to the schema**

In `src/db/schema.ts`, directly above the `// Append-only: the newest row per tenant is the current branding.` comment, add:

```ts
export const BRANDING_ASSET_KINDS = ['logo', 'favicon'] as const
export const BRANDING_ASSET_TYPES = ['image/png', 'image/svg+xml'] as const
export const LOGO_MAX_BYTES = 512 * 1024
export const FAVICON_MAX_BYTES = 100 * 1024
```

- [ ] **Step 4: Write the detection**

Replace `src/lib/image-type.ts` with:

```ts
import type { BRANDING_ASSET_TYPES, PROFILE_PHOTO_TYPES } from '../db/schema.ts'

type PhotoType = (typeof PROFILE_PHOTO_TYPES)[number]
type BrandingAssetType = (typeof BRANDING_ASSET_TYPES)[number]

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

const startsWith = (bytes: Buffer, signature: number[], offset = 0) =>
  signature.every((byte, index) => bytes[offset + index] === byte)

// What an upload really is, read from its first bytes. The Content-Type header is only the
// sender's claim, and the type saved here is the one the photo is later served with.
export function photoTypeOf(bytes: Buffer): PhotoType | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(bytes, PNG_SIGNATURE)) return 'image/png'
  // 'RIFF', four size bytes, then 'WEBP'
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8))
    return 'image/webp'
  return null
}

// A logo or favicon: a PNG, or an SVG.
export function brandingAssetTypeOf(bytes: Buffer): BrandingAssetType | null {
  if (startsWith(bytes, PNG_SIGNATURE)) return 'image/png'
  return svgText(bytes) === null ? null : 'image/svg+xml'
}

// An SVG has no signature, so it's recognised by its text: valid UTF-8 that starts with
// `<svg` or an XML prolog and has an svg element. Returns that text, BOM and leading
// whitespace removed, or null.
export function svgText(bytes: Buffer): string | null {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
  const start = text.replace(/^\uFEFF/, '').trimStart()
  if (!start.startsWith('<svg') && !start.startsWith('<?xml')) return null
  return /<svg[\s>/]/i.test(start) ? start : null
}

const UNSAFE_SVG_PATTERNS = [/<script/i, /<foreignobject/i, /\son[a-z]+\s*=/i, /javascript:/i]
const HREF = /(?:xlink:)?href\s*=\s*["']?([^"'\s>]*)/gi

// Defense in depth: assets are only shown through <img> and favicons, and served with a
// sandbox policy, so a script couldn't run anyway. Refusing these keeps the stored files plain.
export function isUnsafeSvg(text: string): boolean {
  if (UNSAFE_SVG_PATTERNS.some((pattern) => pattern.test(text))) return true
  for (const [, value] of text.matchAll(HREF)) {
    if (!value.startsWith('#') && !value.startsWith('data:image/')) return true
  }
  return false
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `npm test -- src/lib/image-type.test.ts`
Expected: PASS.

- [ ] **Step 6: Check and commit**

Run `npm run typecheck`, then `npx biome check --line-ending=crlf .`, then `npm test`. All must pass.

```bash
git add src/db/schema.ts src/lib/image-type.ts src/lib/image-type.test.ts
git commit -m "feat: recognise PNG and SVG logos and refuse unsafe SVGs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: API – `branding_assets` table and versions that point at it

Repo: relay-api.

**Files:**
- Modify: `src/db/schema.ts` (add `brandingAssets`; add `logoAssetId`/`faviconAssetId` with FKs; remove `logoUrl`/`faviconUrl`)
- Create: `drizzle/0009_branding_assets.sql`, `drizzle/0010_drop_branding_urls.sql` and their `drizzle/meta` snapshot/journal entries (generated)
- Modify: `src/modules/branding/branding.queries.ts`
- Modify: `src/modules/branding/branding.service.ts`
- Test: `src/modules/branding/branding.test.ts`

**Interfaces:**
- Consumes: Task 1's constants.
- Produces:
  - `brandingAssets` table (`BrandingAsset` type not needed)
  - `queries.insertBranding(tenantId, values, tx = db)`
  - `queries.insertAsset(tenantId, { kind, contentType, data, createdBy }, tx): Promise<{ id: string }>`
  - `queries.findAsset(id): Promise<{ contentType, data } | undefined>`
  - in the service:
    - `assetPath(id: string | null | undefined): string | null`, giving `/branding/assets/<id>`
    - `carryOver(latest)`, giving `{ primaryColor, accentColor, logoAssetId, faviconAssetId }`
    - `findTenantOr404` (exported)

- [ ] **Step 1: Write the failing tests**

In `src/modules/branding/branding.test.ts`:
- Change the schema import to `import { brandingAssets, brandingVersions, tenants } from '../../db/schema.ts'`.
- Append:

```ts
describe('branding assets in versions', () => {
  async function insertAsset(tenantId: string, createdBy: string, kind: 'logo' | 'favicon') {
    const [asset] = await db
      .insert(brandingAssets)
      .values({
        tenantId,
        kind,
        contentType: 'image/svg+xml',
        data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
        createdBy,
      })
      .returning()
    return asset
  }

  it('gives logo and favicon paths under the API', async () => {
    const desert = await createTenant('desert')
    const admin = await createUser('superadmin', null)
    const logo = await insertAsset(desert.id, admin.id, 'logo')
    const favicon = await insertAsset(desert.id, admin.id, 'favicon')
    await db.insert(brandingVersions).values({
      tenantId: desert.id,
      ...DEFAULT_COLORS,
      logoAssetId: logo.id,
      faviconAssetId: favicon.id,
      createdBy: admin.id,
    })

    const res = await request(app).get('/api/branding').set('X-Tenant-Host', 'desert.localhost')

    expect(res.body.logoUrl).toBe(`/branding/assets/${logo.id}`)
    expect(res.body.faviconUrl).toBe(`/branding/assets/${favicon.id}`)
  })

  it('keeps the logo and favicon when the colors are saved', async () => {
    const desert = await createTenant('desert')
    const admin = await createUser('superadmin', null)
    const logo = await insertAsset(desert.id, admin.id, 'logo')
    const favicon = await insertAsset(desert.id, admin.id, 'favicon')
    await db.insert(brandingVersions).values({
      tenantId: desert.id,
      ...DEFAULT_COLORS,
      logoAssetId: logo.id,
      faviconAssetId: favicon.id,
      createdBy: admin.id,
    })

    const res = await request(app)
      .put(`/api/admin/tenants/${desert.id}/branding`)
      .set('Cookie', await signIn(admin.email))
      .send({ primaryColor: '#111111', accentColor: '#222222' })
      .expect(200)

    expect(res.body).toMatchObject({
      primaryColor: '#111111',
      logoUrl: `/branding/assets/${logo.id}`,
      faviconUrl: `/branding/assets/${favicon.id}`,
    })
  })

  it("refuses a version that points at another contractor's asset", async () => {
    const desert = await createTenant('desert')
    const other = await createTenant('other')
    const admin = await createUser('superadmin', null)
    const othersLogo = await insertAsset(other.id, admin.id, 'logo')

    await expect(
      db.insert(brandingVersions).values({
        tenantId: desert.id,
        ...DEFAULT_COLORS,
        logoAssetId: othersLogo.id,
        createdBy: admin.id,
      }),
    ).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npm test -- src/modules/branding/branding.test.ts`
Expected: FAIL. TypeScript/vitest reports that `brandingAssets` is not exported from the schema, or that the `logoAssetId` column is unknown.

- [ ] **Step 3: Add the table and the new columns (keep the old ones for now)**

In `src/db/schema.ts`, below the four constants from Task 1 and above the `brandingVersions` comment, add:

```ts
// A contractor's uploaded logo or favicon. Never changed or deleted: branding versions point
// at these, the old versions included. In Postgres like photos, until file storage is chosen.
export const brandingAssets = pgTable(
  'branding_assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    kind: text('kind', { enum: BRANDING_ASSET_KINDS }).notNull(),
    contentType: text('content_type', { enum: BRANDING_ASSET_TYPES }).notNull(),
    data: bytea('data').notNull(),
    // Plain FK: the uploader is a superadmin, who has no tenant.
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique().on(t.tenantId, t.id),
    check('branding_assets_kind_valid', oneOf(t.kind, BRANDING_ASSET_KINDS)),
    check('branding_assets_content_type_valid', oneOf(t.contentType, BRANDING_ASSET_TYPES)),
    check(
      'branding_assets_size',
      sql`octet_length(${t.data}) between 1 and ${sql.raw(String(LOGO_MAX_BYTES))}`,
    ),
  ],
)
```

In `brandingVersions`, add after `faviconUrl: text('favicon_url'),`:

```ts
    logoAssetId: uuid('logo_asset_id'),
    faviconAssetId: uuid('favicon_asset_id'),
```

and add to its constraint list (after the two color checks):

```ts
    // A version can only use its own contractor's images.
    foreignKey({
      name: 'branding_versions_logo_fk',
      columns: [t.tenantId, t.logoAssetId],
      foreignColumns: [brandingAssets.tenantId, brandingAssets.id],
    }),
    foreignKey({
      name: 'branding_versions_favicon_fk',
      columns: [t.tenantId, t.faviconAssetId],
      foreignColumns: [brandingAssets.tenantId, brandingAssets.id],
    }),
```

`foreignKey`, `unique`, `check`, `sql`, `bytea`, `oneOf`, `tenantId` and `createdAt` are already used in this file. Check the import list and add `foreignKey`/`unique` only if missing.

- [ ] **Step 4: Generate migration 0009**

Run: `npm run db:generate -- --name branding_assets`
Expected: it writes `drizzle/0009_branding_assets.sql` without asking any question. Open the file and check that it has, and only has:
- `CREATE TABLE "branding_assets"` with the three checks
- the `branding_assets_tenant_id_id_unique` constraint
- the `tenant_id` and `created_by` FKs
- `ALTER TABLE "branding_versions" ADD COLUMN "logo_asset_id"` and `"favicon_asset_id"`
- the two composite FKs

If it does anything else, or prompts, stop and report BLOCKED with the output.

- [ ] **Step 5: Drop the old columns and generate migration 0010**

In `src/db/schema.ts`, delete these two lines from `brandingVersions`:

```ts
    logoUrl: text('logo_url'),
    faviconUrl: text('favicon_url'),
```

Run: `npm run db:generate -- --name drop_branding_urls`
Expected: it writes `drizzle/0010_drop_branding_urls.sql` containing only:

```sql
ALTER TABLE "branding_versions" DROP COLUMN "logo_url";--> statement-breakpoint
ALTER TABLE "branding_versions" DROP COLUMN "favicon_url";
```

If it prompts or writes anything else, stop and report BLOCKED.

- [ ] **Step 6: Update the queries**

In `src/modules/branding/branding.queries.ts`:
- Change the imports to:

```ts
import { desc, eq } from 'drizzle-orm'
import { type Db, db } from '../../db/client.ts'
import {
  type BrandingVersion,
  brandingAssets,
  brandingVersions,
  type Tenant,
  tenants,
} from '../../db/schema.ts'
```

- Replace `insertBranding` with:

```ts
export async function insertBranding(
  tenantId: string,
  values: Omit<typeof brandingVersions.$inferInsert, 'tenantId'>,
  tx: Db = db,
) {
  await tx.insert(brandingVersions).values({ ...values, tenantId })
}

export async function insertAsset(
  tenantId: string,
  values: Omit<typeof brandingAssets.$inferInsert, 'tenantId' | 'id' | 'createdAt'>,
  tx: Db,
) {
  const [asset] = await tx
    .insert(brandingAssets)
    .values({ ...values, tenantId })
    .returning({ id: brandingAssets.id })
  return asset
}

// Not tenant-scoped: images are public, found by their random id.
export async function findAsset(id: string) {
  const [asset] = await db
    .select({ contentType: brandingAssets.contentType, data: brandingAssets.data })
    .from(brandingAssets)
    .where(eq(brandingAssets.id, id))
    .limit(1)
  return asset
}
```

- [ ] **Step 7: Update the service**

In `src/modules/branding/branding.service.ts`:
- Change the schema import to `import type { BrandingVersion, Tenant } from '../../db/schema.ts'`.
- Replace `getBranding` and `updateBranding`, and export `findTenantOr404`, with:

```ts
// Where the web app loads an image from: a path under the API, like a technician's photoUrl.
export function assetPath(id: string | null | undefined): string | null {
  return id ? `/branding/assets/${id}` : null
}

export async function getBranding(tenant: Tenant): Promise<Branding> {
  const latest = await queries.findLatestBranding(tenant.id)
  return {
    name: tenant.name,
    slug: tenant.slug,
    primaryColor: latest?.primaryColor ?? DEFAULT_COLORS.primaryColor,
    accentColor: latest?.accentColor ?? DEFAULT_COLORS.accentColor,
    logoUrl: assetPath(latest?.logoAssetId),
    faviconUrl: assetPath(latest?.faviconAssetId),
  }
}

// Everything the latest version has, so a new version changes only what it means to.
export function carryOver(latest: BrandingVersion | undefined) {
  return {
    primaryColor: latest?.primaryColor ?? DEFAULT_COLORS.primaryColor,
    accentColor: latest?.accentColor ?? DEFAULT_COLORS.accentColor,
    logoAssetId: latest?.logoAssetId ?? null,
    faviconAssetId: latest?.faviconAssetId ?? null,
  }
}

// Saves a new version (older ones stay for history and revert) and tells open dashboards.
export async function updateBranding(
  tenantId: string,
  input: BrandingInput,
  userId: string,
): Promise<Branding> {
  const tenant = await findTenantOr404(tenantId)
  const current = await queries.findLatestBranding(tenantId)
  await queries.insertBranding(tenantId, { ...carryOver(current), ...input, createdBy: userId })
  emitToTenant(tenantId, 'branding.updated', { tenantId })
  return getBranding(tenant)
}
```

and change `async function findTenantOr404` to `export async function findTenantOr404`.

- [ ] **Step 8: Run the tests to see them pass**

Run: `npm test -- src/modules/branding`
Expected: PASS, including the existing tests that expect `logoUrl: null` and `faviconUrl: null`. The suite's global setup applies the new migrations to `relay_test`.

- [ ] **Step 9: Check and commit**

Run `npm run typecheck`, then `npx biome check --line-ending=crlf .`, then `npm test`. All must pass.

```bash
git add src/db/schema.ts drizzle/0009_branding_assets.sql drizzle/0010_drop_branding_urls.sql drizzle/meta src/modules/branding/branding.queries.ts src/modules/branding/branding.service.ts src/modules/branding/branding.test.ts
git commit -m "feat: store branding images and point versions at them

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: API – upload, remove and serve a logo or favicon

Repo: relay-api.

**Files:**
- Modify: `src/modules/branding/branding.service.ts` (add `setAsset`, `removeAsset`, `getAsset`)
- Modify: `src/modules/branding/branding.routes.ts`
- Create: `src/modules/branding/branding-assets.test.ts`

**Interfaces:**
- Consumes:
  - Task 1: `brandingAssetTypeOf`, `svgText`, `isUnsafeSvg`, and the constants.
  - Task 2: `queries.insertAsset`, `queries.insertBranding(…, tx)`, `queries.findAsset`, `carryOver`, `findTenantOr404`, `getBranding`.
  - Existing: `audit.insertUserAction(tenantId, event, tx)` from `../audit/audit.queries.ts`, and `TenantParams` from `./branding.schemas.ts`.
- Produces: the routes below, and the `AssetKind` type (`'logo' | 'favicon'`).

- [ ] **Step 1: Write the failing tests**

Create `src/modules/branding/branding-assets.test.ts`:

```ts
import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'
import { createTenant, createUser, resetDb, signIn } from '../../../test/helpers.ts'
import { createApp } from '../../app.ts'
import { db } from '../../db/client.ts'
import { auditEvents, brandingAssets, brandingVersions } from '../../db/schema.ts'
import { DEFAULT_COLORS } from './branding.service.ts'

const app = createApp()

beforeEach(resetDb)

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 7),
])
const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
)

async function setup() {
  const desert = await createTenant('desert')
  const admin = await createUser('superadmin', null)
  const cookie = await signIn(admin.email)
  const base = `/api/admin/tenants/${desert.id}/branding`
  return { desert, admin, cookie, base }
}

function upload(path: string, cookie: string, body: Buffer, type = 'application/octet-stream') {
  return request(app).put(path).set('Cookie', cookie).set('Content-Type', type).send(body)
}

function assetId(url: string) {
  return url.split('/').at(-1)!
}

describe('PUT /api/admin/tenants/:tenantId/branding/logo and /favicon', () => {
  it('saves a PNG logo as a new version and keeps the colors and favicon', async () => {
    const { desert, admin, cookie, base } = await setup()
    await request(app)
      .put(base)
      .set('Cookie', cookie)
      .send({ primaryColor: '#111111', accentColor: '#222222' })
      .expect(200)
    const favicon = await upload(`${base}/favicon`, cookie, SVG, 'image/svg+xml').expect(200)

    const res = await upload(`${base}/logo`, cookie, PNG, 'image/png').expect(200)

    expect(res.body).toMatchObject({
      primaryColor: '#111111',
      accentColor: '#222222',
      logoUrl: expect.stringMatching(/^\/branding\/assets\/[0-9a-f-]{36}$/),
      faviconUrl: favicon.body.faviconUrl,
    })
    const [asset] = await db
      .select()
      .from(brandingAssets)
      .where(eq(brandingAssets.id, assetId(res.body.logoUrl)))
    expect(asset).toMatchObject({ tenantId: desert.id, kind: 'logo', contentType: 'image/png' })
    expect(Buffer.compare(asset.data, PNG)).toBe(0)
    const versions = await db
      .select()
      .from(brandingVersions)
      .where(eq(brandingVersions.tenantId, desert.id))
    expect(versions).toHaveLength(3)
    const [event] = await db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.tenantId, desert.id), eq(auditEvents.action, 'branding.logo_updated')),
      )
    expect(event).toMatchObject({
      actorUserId: admin.id,
      entityType: 'tenant',
      entityId: desert.id,
      data: { assetId: asset.id },
    })
  })

  it('reads the type from the bytes, not the header', async () => {
    const { cookie, base } = await setup()

    const res = await upload(`${base}/favicon`, cookie, SVG, 'image/png').expect(200)

    const [asset] = await db
      .select({ contentType: brandingAssets.contentType, kind: brandingAssets.kind })
      .from(brandingAssets)
      .where(eq(brandingAssets.id, assetId(res.body.faviconUrl)))
    expect(asset).toEqual({ contentType: 'image/svg+xml', kind: 'favicon' })
    expect(res.body.logoUrl).toBeNull()
    expect(res.body.primaryColor).toBe(DEFAULT_COLORS.primaryColor)
  })

  it.each([
    ['a JPEG', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), 'unsupported_image', 'Use a PNG or SVG file.'],
    ['an empty body', Buffer.alloc(0), 'unsupported_image', 'Use a PNG or SVG file.'],
    [
      'an SVG with a script',
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      'unsafe_svg',
      'This SVG has scripts or links in it. Export it again as a plain SVG.',
    ],
  ])('refuses %s', async (_label, body, code, message) => {
    const { desert, cookie, base } = await setup()

    const res = await upload(`${base}/logo`, cookie, body).expect(400)

    expect(res.body.error).toEqual({ code, message })
    const versions = await db
      .select()
      .from(brandingVersions)
      .where(eq(brandingVersions.tenantId, desert.id))
    expect(versions).toEqual([])
  })

  it('refuses a logo over 512 KB and a favicon over 100 KB', async () => {
    const { cookie, base } = await setup()
    const big = (size: number) => Buffer.concat([PNG, Buffer.alloc(size - PNG.length, 1)])

    const logo = await upload(`${base}/logo`, cookie, big(512 * 1024 + 1)).expect(400)
    expect(logo.body.error).toEqual({
      code: 'image_too_large',
      message: 'The logo must be 512 KB or smaller.',
    })
    const favicon = await upload(`${base}/favicon`, cookie, big(100 * 1024 + 1)).expect(400)
    expect(favicon.body.error).toEqual({
      code: 'image_too_large',
      message: 'The favicon must be 100 KB or smaller.',
    })
    await upload(`${base}/logo`, cookie, big(512 * 1024)).expect(200)
  })

  it('answers 413 for a body over 1 MB', async () => {
    const { cookie, base } = await setup()

    await upload(`${base}/logo`, cookie, Buffer.alloc(1024 * 1024 + 1, 1)).expect(413)
  })

  it('404s for an unknown contractor and needs a signed-in superadmin', async () => {
    const { desert, cookie } = await setup()
    const owner = await createUser('owner', desert.id)
    const path = `/api/admin/tenants/${desert.id}/branding/logo`

    await upload(`/api/admin/tenants/${randomUUID()}/branding/logo`, cookie, PNG).expect(404)
    await request(app).put(path).send(PNG).expect(401)
    await upload(path, await signIn(owner.email), PNG).expect(403)
  })
})

describe('DELETE /api/admin/tenants/:tenantId/branding/logo and /favicon', () => {
  it('saves a version without the logo and keeps the favicon', async () => {
    const { desert, admin, cookie, base } = await setup()
    await upload(`${base}/logo`, cookie, PNG).expect(200)
    const favicon = await upload(`${base}/favicon`, cookie, SVG).expect(200)

    const res = await request(app).delete(`${base}/logo`).set('Cookie', cookie).expect(200)

    expect(res.body.logoUrl).toBeNull()
    expect(res.body.faviconUrl).toBe(favicon.body.faviconUrl)
    const [event] = await db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.tenantId, desert.id), eq(auditEvents.action, 'branding.logo_removed')),
      )
    expect(event).toMatchObject({ actorUserId: admin.id, data: {} })
  })

  it('still saves a version when there is nothing to remove', async () => {
    const { desert, cookie, base } = await setup()

    const res = await request(app).delete(`${base}/favicon`).set('Cookie', cookie).expect(200)

    expect(res.body.faviconUrl).toBeNull()
    const versions = await db
      .select()
      .from(brandingVersions)
      .where(eq(brandingVersions.tenantId, desert.id))
    expect(versions).toHaveLength(1)
  })

  it('needs a superadmin', async () => {
    const { desert, base } = await setup()
    const owner = await createUser('owner', desert.id)

    await request(app)
      .delete(`${base}/logo`)
      .set('Cookie', await signIn(owner.email))
      .expect(403)
  })
})

describe('GET /api/branding/assets/:assetId', () => {
  it('serves the bytes to anyone, with safe, long-lived headers', async () => {
    const { cookie, base } = await setup()
    const uploaded = await upload(`${base}/logo`, cookie, SVG).expect(200)

    const res = await request(app).get(`/api${uploaded.body.logoUrl}`).buffer(true).expect(200)

    expect(res.headers['content-type']).toMatch(/^image\/svg\+xml/)
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['content-security-policy']).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    )
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable')
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin')
    expect(Buffer.from(res.body).toString()).toBe(SVG.toString())
  })

  it('serves a PNG with its type', async () => {
    const { cookie, base } = await setup()
    const uploaded = await upload(`${base}/favicon`, cookie, PNG).expect(200)

    const res = await request(app).get(`/api${uploaded.body.faviconUrl}`).expect(200)

    expect(res.headers['content-type']).toBe('image/png')
    expect(Buffer.compare(res.body, PNG)).toBe(0)
  })

  it('404s for an unknown or malformed id', async () => {
    const unknown = await request(app).get(`/api/branding/assets/${randomUUID()}`).expect(404)
    expect(unknown.body.error).toEqual({ code: 'not_found', message: 'Image not found' })
    await request(app).get('/api/branding/assets/not-a-uuid').expect(404)
  })
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npm test -- src/modules/branding/branding-assets.test.ts`
Expected: FAIL, because the routes answer `404 Route not found`.

- [ ] **Step 3: Add the service functions**

In `src/modules/branding/branding.service.ts`:
- Add these imports:

```ts
import { db } from '../../db/client.ts'
import {
  type BRANDING_ASSET_KINDS,
  FAVICON_MAX_BYTES,
  LOGO_MAX_BYTES,
} from '../../db/schema.ts'
import { brandingAssetTypeOf, isUnsafeSvg, svgText } from '../../lib/image-type.ts'
import * as audit from '../audit/audit.queries.ts'
```

  Merge `BrandingVersion` and `Tenant` into the same schema import as `import type` members.
- Append:

```ts
export type AssetKind = (typeof BRANDING_ASSET_KINDS)[number]

const ASSET_COLUMN = { logo: 'logoAssetId', favicon: 'faviconAssetId' } as const
const MAX_BYTES = { logo: LOGO_MAX_BYTES, favicon: FAVICON_MAX_BYTES }
const TOO_LARGE = {
  logo: 'The logo must be 512 KB or smaller.',
  favicon: 'The favicon must be 100 KB or smaller.',
}

// Stores the uploaded file and saves a new version that uses it. `body` is the raw request
// body: a Buffer, or {} when nothing was sent.
export async function setAsset(
  tenantId: string,
  kind: AssetKind,
  body: unknown,
  userId: string,
): Promise<Branding> {
  const tenant = await findTenantOr404(tenantId)
  const data = Buffer.isBuffer(body) ? body : Buffer.alloc(0)
  if (data.length > MAX_BYTES[kind]) throw new HttpError(400, 'image_too_large', TOO_LARGE[kind])
  const contentType = brandingAssetTypeOf(data)
  if (!contentType) throw new HttpError(400, 'unsupported_image', 'Use a PNG or SVG file.')
  if (contentType === 'image/svg+xml' && isUnsafeSvg(svgText(data) ?? '')) {
    throw new HttpError(
      400,
      'unsafe_svg',
      'This SVG has scripts or links in it. Export it again as a plain SVG.',
    )
  }

  const latest = await queries.findLatestBranding(tenantId)
  await db.transaction(async (tx) => {
    const asset = await queries.insertAsset(
      tenantId,
      { kind, contentType, data, createdBy: userId },
      tx,
    )
    await queries.insertBranding(
      tenantId,
      { ...carryOver(latest), [ASSET_COLUMN[kind]]: asset.id, createdBy: userId },
      tx,
    )
    await audit.insertUserAction(
      tenantId,
      {
        actorUserId: userId,
        action: `branding.${kind}_updated`,
        entityType: 'tenant',
        entityId: tenantId,
        data: { assetId: asset.id },
      },
      tx,
    )
  })
  emitToTenant(tenantId, 'branding.updated', { tenantId })
  return getBranding(tenant)
}

// Saves a new version without the logo or favicon. The image itself stays for older versions.
export async function removeAsset(
  tenantId: string,
  kind: AssetKind,
  userId: string,
): Promise<Branding> {
  const tenant = await findTenantOr404(tenantId)
  const latest = await queries.findLatestBranding(tenantId)
  await db.transaction(async (tx) => {
    await queries.insertBranding(
      tenantId,
      { ...carryOver(latest), [ASSET_COLUMN[kind]]: null, createdBy: userId },
      tx,
    )
    await audit.insertUserAction(
      tenantId,
      {
        actorUserId: userId,
        action: `branding.${kind}_removed`,
        entityType: 'tenant',
        entityId: tenantId,
      },
      tx,
    )
  })
  emitToTenant(tenantId, 'branding.updated', { tenantId })
  return getBranding(tenant)
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function getAsset(assetId: string) {
  const asset = UUID.test(assetId) ? await queries.findAsset(assetId) : undefined
  if (!asset) throw new HttpError(404, 'not_found', 'Image not found')
  return asset
}
```

`insertUserAction` stores `data` with a database default of `{}`, so the removal event's data is `{}`. If the audit type requires `data`, pass `data: {}`.

- [ ] **Step 4: Add the routes**

In `src/modules/branding/branding.routes.ts`:
- Change the imports to:

```ts
import express, { Router, type Response } from 'express'
import { BRANDING_ASSET_KINDS } from '../../db/schema.ts'
import { requireRole } from '../../middleware/auth.ts'
import { tenantFromHost } from '../../middleware/tenant.ts'
import { BrandingInput, TenantParams } from './branding.schemas.ts'
import * as branding from './branding.service.ts'
```

- Append:

```ts
// The image is the request body itself, not JSON. The service checks its type and size.
const assetBody = express.raw({ type: () => true, limit: '1mb' })

for (const kind of BRANDING_ASSET_KINDS) {
  brandingRoutes.put(
    `/admin/tenants/:tenantId/branding/${kind}`,
    requireRole('superadmin'),
    assetBody,
    async (req, res) => {
      const { tenantId } = TenantParams.parse(req.params)
      res.json(await branding.setAsset(tenantId, kind, req.body, req.user!.id))
    },
  )

  brandingRoutes.delete(
    `/admin/tenants/:tenantId/branding/${kind}`,
    requireRole('superadmin'),
    async (req, res) => {
      const { tenantId } = TenantParams.parse(req.params)
      res.json(await branding.removeAsset(tenantId, kind, req.user!.id))
    },
  )
}

// Public: <img> and favicon requests can't send a session or X-Tenant-Host. The sandbox
// policy means an SVG opened directly can't run or load anything.
brandingRoutes.get('/branding/assets/:assetId', async (req, res) => {
  sendAsset(res, await branding.getAsset(req.params.assetId))
})

function sendAsset(res: Response, asset: { contentType: string; data: Buffer }) {
  res
    .set({
      'Content-Type': asset.contentType,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    })
    .send(asset.data)
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `npm test -- src/modules/branding`
Expected: PASS. If the SVG serving test's `res.body` isn't a Buffer (supertest only buffers some types), keep `.buffer(true)` and also add `.parse((response, callback) => { const chunks: Buffer[] = []; response.on('data', (c: Buffer) => chunks.push(c)); response.on('end', () => callback(null, Buffer.concat(chunks))) })` to that one request.

- [ ] **Step 6: Check and commit**

Run `npm run typecheck`, then `npx biome check --line-ending=crlf .`, then `npm test`. All must pass.

```bash
git add src/modules/branding/branding.service.ts src/modules/branding/branding.routes.ts src/modules/branding/branding-assets.test.ts
git commit -m "feat: let the superadmin upload and remove a logo and favicon

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Web – branding image hooks, upload errors and favicon logic

Repo: relay-web.

**Files:**
- Modify: `src/features/branding/api.ts`
- Create: `src/features/branding/upload-error.ts`
- Create: `src/features/branding/upload-error.test.ts`
- Create: `src/features/branding/favicon.ts`
- Create: `src/features/branding/favicon.test.ts`

**Interfaces:**
- Consumes:
  - From the API (Tasks 2–3):
    - `logoUrl` and `faviconUrl` are paths like `/branding/assets/<id>`, or null.
    - `PUT|DELETE /admin/tenants/:tenantId/branding/{logo|favicon}` returns the `Branding` shape.
  - Existing: `api.put(path, Blob, schema)` sends a Blob raw with its type; `env.VITE_API_URL` from `@/lib/env`; `errorMessage` from `@/lib/errors`; `ApiError` from `@/lib/api`.
- Produces:
  - `AssetKind = 'logo' | 'favicon'`
  - `useSetBrandingAsset(tenantId, kind)`, which mutates with a `File`
  - `useRemoveBrandingAsset(tenantId, kind)`
  - `uploadErrorMessage(error, kind): string`
  - `IconLink = { href: string; sizes: string | null; type: string | null }`
  - `faviconLinks(originals, faviconUrl): IconLink[]`
  - `applyFavicon(faviconUrl: string | null): void`

- [ ] **Step 1: Write the failing tests**

Create `src/features/branding/upload-error.test.ts`:

```ts
import { expect, it } from 'vitest'
import { ApiError } from '@/lib/api'
import { uploadErrorMessage } from './upload-error'

it('turns a 413 into the size limit for the kind', () => {
  const tooBig = new ApiError(413, { code: 'bad_request', message: 'request entity too large' })
  expect(uploadErrorMessage(tooBig, 'logo')).toBe('The logo must be 512 KB or smaller.')
  expect(uploadErrorMessage(tooBig, 'favicon')).toBe('The favicon must be 100 KB or smaller.')
})

it('shows the API’s own message for the other errors', () => {
  const unsafe = new ApiError(400, {
    code: 'unsafe_svg',
    message: 'This SVG has scripts or links in it. Export it again as a plain SVG.',
  })
  expect(uploadErrorMessage(unsafe, 'logo')).toBe(
    'This SVG has scripts or links in it. Export it again as a plain SVG.',
  )
})
```

Create `src/features/branding/favicon.test.ts`:

```ts
import { expect, it } from 'vitest'
import { faviconLinks, type IconLink } from './favicon'

const RELAY: IconLink[] = [
  { href: '/favicon.ico', sizes: '48x48', type: null },
  { href: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' },
]

it('points every icon link at the contractor’s favicon', () => {
  expect(faviconLinks(RELAY, '/api/branding/assets/abc')).toEqual([
    { href: '/api/branding/assets/abc', sizes: null, type: null },
    { href: '/api/branding/assets/abc', sizes: null, type: null },
  ])
})

it('gives Relay’s icons back exactly when there is no favicon', () => {
  expect(faviconLinks(RELAY, null)).toEqual(RELAY)
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npm test -- src/features/branding`
Expected: FAIL, because `./upload-error` and `./favicon` can't be resolved.

- [ ] **Step 3: Write `upload-error.ts`**

```ts
import { ApiError } from '@/lib/api'
import { errorMessage } from '@/lib/errors'
import type { AssetKind } from './api'

const TOO_LARGE: Record<AssetKind, string> = {
  logo: 'The logo must be 512 KB or smaller.',
  favicon: 'The favicon must be 100 KB or smaller.',
}

// What to show under the Logo or Favicon row when an upload fails. A file over the request
// limit is refused by Express before relay-api's own check, with a technical message.
export function uploadErrorMessage(error: unknown, kind: AssetKind): string {
  if (error instanceof ApiError && error.status === 413) return TOO_LARGE[kind]
  return errorMessage(error)
}
```

- [ ] **Step 4: Write `favicon.ts`**

```ts
export type IconLink = { href: string; sizes: string | null; type: string | null }

// What each <link rel="icon"> should say: the contractor's favicon, or Relay's own back.
// `sizes` and `type` are dropped for the contractor's, so the browser doesn't skip it.
export function faviconLinks(originals: IconLink[], faviconUrl: string | null): IconLink[] {
  if (!faviconUrl) return originals
  return originals.map(() => ({ href: faviconUrl, sizes: null, type: null }))
}

let saved: { link: HTMLLinkElement; original: IconLink }[] | undefined

// Applies faviconLinks to the page. Relay's links from index.html are read once, first time.
export function applyFavicon(faviconUrl: string | null) {
  saved ??= Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]'), (link) => ({
    link,
    original: {
      href: link.getAttribute('href') ?? '',
      sizes: link.getAttribute('sizes'),
      type: link.getAttribute('type'),
    },
  }))
  const wanted = faviconLinks(
    saved.map((entry) => entry.original),
    faviconUrl,
  )
  saved.forEach(({ link }, index) => {
    const { href, sizes, type } = wanted[index]
    link.setAttribute('href', href)
    setOrRemove(link, 'sizes', sizes)
    setOrRemove(link, 'type', type)
  })
}

function setOrRemove(link: HTMLLinkElement, name: string, value: string | null) {
  if (value === null) link.removeAttribute(name)
  else link.setAttribute(name, value)
}
```

- [ ] **Step 5: Extend the branding hooks**

In `src/features/branding/api.ts`:
- Add `import { env } from '@/lib/env'`.
- In the `Branding` schema, replace the two URL fields with:

```ts
  // Arrive as paths under the API ('/branding/assets/…'); made loadable here.
  logoUrl: z
    .string()
    .nullable()
    .transform((path) => path && `${env.VITE_API_URL}${path}`),
  faviconUrl: z
    .string()
    .nullable()
    .transform((path) => path && `${env.VITE_API_URL}${path}`),
```

- Append:

```ts
export type AssetKind = 'logo' | 'favicon'

// The file is sent as it is; relay-api checks its type and size.
export function useSetBrandingAsset(tenantId: string, kind: AssetKind) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (file: File) => api.put(`/admin/tenants/${tenantId}/branding/${kind}`, file, Branding),
    onSuccess: (branding) => {
      queryClient.setQueryData(tenantBrandingKey(tenantId), branding)
      queryClient.invalidateQueries({ queryKey: brandingKey })
    },
  })
}

export function useRemoveBrandingAsset(tenantId: string, kind: AssetKind) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => api.delete(`/admin/tenants/${tenantId}/branding/${kind}`, Branding),
    onSuccess: (branding) => {
      queryClient.setQueryData(tenantBrandingKey(tenantId), branding)
      queryClient.invalidateQueries({ queryKey: brandingKey })
    },
  })
}
```

`Branding` is now a schema whose output differs from its input, because of the transform. `z.infer` gives the output type, which is the one the app uses. `setQueryData` stores the parsed output. Both are correct as they are.

- [ ] **Step 6: Run the tests to see them pass**

Run: `npm test -- src/features/branding`
Expected: PASS.

- [ ] **Step 7: Check and commit**

Run `npm run typecheck`, then `npx biome check --line-ending=crlf .`, then `npm test`. All must pass, apart from the known `landing.test.ts`.

```bash
git add src/features/branding/api.ts src/features/branding/upload-error.ts src/features/branding/upload-error.test.ts src/features/branding/favicon.ts src/features/branding/favicon.test.ts
git commit -m "feat: add the branding image hooks and favicon logic

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Web – Logo and Favicon rows on the admin card

Repo: relay-web.

**Files:**
- Create: `src/features/branding/branding-assets.tsx`
- Modify: `src/routes/admin.tsx` (render `<BrandingAssets>` under the branding form in `TenantCard`)

**Interfaces:**
- Consumes:
  - Task 4: `useSetBrandingAsset`, `useRemoveBrandingAsset`, `AssetKind`, `uploadErrorMessage`, and the `Branding` type with absolute `logoUrl`/`faviconUrl`.
  - Existing: `Button`, `Label`, `toast` from `sonner`. In `admin.tsx`, `TenantCard` renders `<BrandingForm tenantId={tenant.id} current={branding.data} />` inside `CardContent` when `branding.data` is loaded.
- Produces: `BrandingAssets({ tenantId, current }: { tenantId: string; current: Branding })`.

This task has no component tests; relay-web has no setup for them, and its logic is tested in Task 4. It is checked with typecheck and lint, and by the controller's manual run.

- [ ] **Step 1: Write the component**

Create `src/features/branding/branding-assets.tsx`:

```tsx
import { type ChangeEvent, useId, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { type AssetKind, type Branding, useRemoveBrandingAsset, useSetBrandingAsset } from './api'
import { uploadErrorMessage } from './upload-error'

const LABELS: Record<AssetKind, { title: string; updated: string; removed: string }> = {
  logo: { title: 'Logo', updated: 'Logo updated', removed: 'Logo removed' },
  favicon: { title: 'Favicon', updated: 'Favicon updated', removed: 'Favicon removed' },
}

// Superadmin only. Each upload or removal becomes a new branding version on the API.
export function BrandingAssets({ tenantId, current }: { tenantId: string; current: Branding }) {
  return (
    <div className="space-y-4 border-t pt-4">
      <AssetRow tenantId={tenantId} kind="logo" url={current.logoUrl} />
      <AssetRow tenantId={tenantId} kind="favicon" url={current.faviconUrl} />
    </div>
  )
}

function AssetRow({ tenantId, kind, url }: { tenantId: string; kind: AssetKind; url: string | null }) {
  const id = useId()
  const input = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const upload = useSetBrandingAsset(tenantId, kind)
  const remove = useRemoveBrandingAsset(tenantId, kind)
  const busy = upload.isPending || remove.isPending
  const labels = LABELS[kind]

  function onPick(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file) return
    setError(null)
    upload.mutate(file, {
      onSuccess: () => toast.success(labels.updated),
      onError: (caught) => setError(uploadErrorMessage(caught, kind)),
    })
  }

  function onRemove() {
    setError(null)
    remove.mutate(undefined, {
      onSuccess: () => toast.success(labels.removed),
      onError: (caught) => setError(uploadErrorMessage(caught, kind)),
    })
  }

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{labels.title}</Label>
      <div className="flex flex-wrap items-center gap-3">
        {/* Checkered, so white and transparent images are visible too. */}
        <div className="flex h-16 w-32 items-center justify-center rounded-md border bg-[repeating-conic-gradient(#e5e7eb_0_25%,#fff_0_50%)] bg-[length:12px_12px] p-1">
          {url ? (
            <img src={url} alt={`${labels.title} preview`} className="max-h-full max-w-full object-contain" />
          ) : (
            <span className="text-sm text-muted-foreground">None</span>
          )}
        </div>
        <input
          ref={input}
          id={id}
          type="file"
          accept="image/png,image/svg+xml"
          className="sr-only"
          onChange={onPick}
        />
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => input.current?.click()}>
          {upload.isPending ? 'Uploading…' : 'Upload'}
        </Button>
        {url && (
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onRemove}>
            Remove
          </Button>
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        PNG or SVG, up to {kind === 'logo' ? '512' : '100'} KB.
      </p>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  )
}
```

- [ ] **Step 2: Show it on the admin card**

In `src/routes/admin.tsx`:
- Add `import { BrandingAssets } from '@/features/branding/branding-assets'`.
- In `TenantCard`, replace:

```tsx
        {branding.data && <BrandingForm tenantId={tenant.id} current={branding.data} />}
```

with:

```tsx
        {branding.data && (
          <div className="space-y-4">
            <BrandingForm tenantId={tenant.id} current={branding.data} />
            <BrandingAssets tenantId={tenant.id} current={branding.data} />
          </div>
        )}
```

If the current line differs slightly, keep its meaning and add `BrandingAssets` right after `BrandingForm`.

- [ ] **Step 3: Check and commit**

Run `npm run typecheck`, then `npx biome check --line-ending=crlf .` (let Biome format the JSX), then `npm test`. All must pass, apart from the known `landing.test.ts`.

```bash
git add src/features/branding/branding-assets.tsx src/routes/admin.tsx
git commit -m "feat: upload a contractor's logo and favicon from the admin page

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Web – show the logo and favicon on the contractor's site

Repo: relay-web.

**Files:**
- Modify: `src/features/booking/booking-shell.tsx`
- Modify: `src/components/sidebar.tsx`
- Modify: `src/components/app-layout.tsx`

**Interfaces:**
- Consumes: Task 4's `applyFavicon(faviconUrl)` and the `Branding` type with absolute `logoUrl`/`faviconUrl`. `useBranding()` is already used in all three files.
- Produces: nothing used later.

- [ ] **Step 1: Logo in the booking hero**

In `src/features/booking/booking-shell.tsx`, inside `<div className="mx-auto max-w-2xl space-y-2">` and before `<div className="flex items-start justify-between gap-4">`, add:

```tsx
          {branding?.logoUrl && (
            <img
              src={branding.logoUrl}
              alt={branding.name}
              className="max-h-14 max-w-48 object-contain"
            />
          )}
```

- [ ] **Step 2: Logo in the sidebar header**

In `src/components/sidebar.tsx`:
- After `const name = branding?.name ?? 'Relay'`, add `const logoUrl = branding?.logoUrl ?? null`.
- Replace the header's `{collapsed ? ( … ) : ( <span className="truncate">{name}</span> )}` block with:

```tsx
        {collapsed ? (
          <span
            title={name}
            className="flex size-8 items-center justify-center overflow-hidden rounded-md bg-white/15 text-sm"
          >
            {logoUrl ? (
              <img src={logoUrl} alt="" className="size-full object-contain" />
            ) : (
              <span aria-hidden>{name.charAt(0)}</span>
            )}
            <span className="sr-only">{name}</span>
          </span>
        ) : logoUrl ? (
          <img src={logoUrl} alt={name} className="max-h-8 max-w-full object-contain" />
        ) : (
          <span className="truncate">{name}</span>
        )}
```

- [ ] **Step 3: Favicon in the tab**

In `src/components/app-layout.tsx`:
- Add `import { applyFavicon } from '@/features/branding/favicon'`.
- Inside the existing `useEffect`, after `document.title = …`, add:

```tsx
    applyFavicon(branding?.faviconUrl ?? null)
```

- Update the component's comment to say it applies the colors, name and favicon.

- [ ] **Step 4: Check and commit**

Run `npm run typecheck`, then `npx biome check --line-ending=crlf .`, then `npm test`. All must pass, apart from the known `landing.test.ts`.

```bash
git add src/features/booking/booking-shell.tsx src/components/sidebar.tsx src/components/app-layout.tsx
git commit -m "feat: show the contractor's logo and favicon on their site

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
