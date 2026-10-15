import type { SiteDesign } from '../../../db/schema.ts'
import type { Html } from '../html.ts'
import type { SiteView } from '../site-view.ts'
import { renderBreeze } from './breeze.ts'
import { renderClean } from './clean.ts'

// One render function per design. They all show the same content; only the look differs.
const RENDERERS: Record<SiteDesign, (view: SiteView) => Html> = {
  breeze: renderBreeze,
  clean: renderClean,
  bold: renderBreeze, // until the bold design is built
}

export function renderSite(view: SiteView): string {
  return RENDERERS[view.design](view).text
}
