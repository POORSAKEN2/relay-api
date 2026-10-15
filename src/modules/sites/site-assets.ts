import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

// The site designs' stylesheets and script, read once at startup from ./designs/. Their URL
// carries a hash of the content, so browsers can cache them for a year and still get a new
// version right after a deploy.
export const SITE_ASSET_FILES = ['breeze.css', 'clean.css', 'site.js'] as const
export type SiteAssetFile = (typeof SITE_ASSET_FILES)[number]

const CONTENT_TYPES: Record<string, string> = {
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
}

const assets = new Map(
  SITE_ASSET_FILES.map((file) => {
    const body = readFileSync(new URL(`./designs/${file}`, import.meta.url))
    const version = createHash('sha256').update(body).digest('hex').slice(0, 10)
    const contentType = CONTENT_TYPES[file.split('.').pop()!]
    return [file as string, { body, contentType, version }]
  }),
)

// '/api/site/assets/breeze.css?v=1a2b3c4d5e'
export function assetUrl(file: SiteAssetFile): string {
  return `/api/site/assets/${file}?v=${assets.get(file)!.version}`
}

export function findAsset(file: string): { body: Buffer; contentType: string } | undefined {
  return assets.get(file)
}
