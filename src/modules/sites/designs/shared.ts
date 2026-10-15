import { type Html, html, raw } from '../html.ts'
import { assetUrl, type SiteAssetFile } from '../site-assets.ts'
import type { SiteView } from '../site-view.ts'

// Pieces every design uses. A design changes the look, never the content, so the words and
// links here are the same on all three.

// The <head>: title, description, brand color, fonts, the design's stylesheet, the shared
// script and the JSON-LD block.
export function pageHead(view: SiteView, options: { css: SiteAssetFile; fontsHref: string }): Html {
  return html`<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${view.name} | AC &amp; Heating Repair in ${view.city}</title>
<meta name="description" content="${view.intro}">
<meta name="theme-color" content="${view.brand.primary}">
${view.faviconUrl && html`<link rel="icon" href="${view.faviconUrl}">`}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${options.fontsHref}">
<link rel="stylesheet" href="${assetUrl(options.css)}">
<script>document.documentElement.classList.add('js')</script>
<script src="${assetUrl('site.js')}" defer></script>
<script type="application/ld+json">${raw(view.jsonLd)}</script>
</head>`
}

// CSS variables for <html style="...">: every design reads its brand colors from these.
export function brandStyle(view: SiteView): string {
  const { primary, onPrimary, accent, onAccent } = view.brand
  return `--brand:${primary};--on-brand:${onPrimary};--accent:${accent};--on-accent:${onAccent}`
}

const ICON_PATHS = {
  phone:
    '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
  calendar:
    '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M8 15h3"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
}

// A line icon in the current text color. Each design sizes `.i` in its stylesheet.
export function icon(name: keyof typeof ICON_PATHS): Html {
  return html`<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${raw(ICON_PATHS[name])}</svg>`
}

const STAR_PATH =
  '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>'

// Five stars, the first `rating` of them filled. Screen readers hear "4 out of 5 stars".
export function stars(rating: number): Html {
  const items = [1, 2, 3, 4, 5].map(
    (n) =>
      html`<svg class="${n <= rating ? 'star' : 'star star-off'}" viewBox="0 0 24 24">${raw(STAR_PATH)}</svg>`,
  )
  return html`<span class="stars" role="img" aria-label="${rating} out of 5 stars">${items}</span>`
}

// The Call / Book bar fixed to the bottom of a phone screen. site.js shows it once the page's
// own buttons (marked data-watch-actions) scroll away.
export function phoneDock(view: SiteView): Html {
  return html`<nav class="dock" aria-label="Quick actions">
  <a class="btn btn-call" href="${view.phone.href}" aria-label="Call ${view.name} at ${view.phone.display}">${icon('phone')}Call</a>
  <a class="btn btn-book" href="${view.bookingUrl}">${icon('calendar')}Book online</a>
</nav>`
}

// The menu: only sections the page shows, so no link jumps to nothing.
export function sectionLinks(view: SiteView): { href: string; label: string }[] {
  return [
    { href: '#services', label: 'Services', shown: view.services.length > 0 },
    { href: '#how', label: 'How it works', shown: true },
    { href: '#reviews', label: 'Reviews', shown: view.reviews.length > 0 },
    { href: '#area', label: 'Service area', shown: view.citiesServed.length > 0 },
    { href: '#faq', label: 'FAQ', shown: view.faqs.length > 0 },
  ]
    .filter((link) => link.shown)
    .map(({ href, label }) => ({ href, label }))
}

// The "How booking works" steps. Fixed copy about Relay's booking page, so it claims nothing
// the contractor's data has to back.
export const BOOKING_STEPS = [
  {
    title: 'Pick what you need',
    text: 'Choose the problem, enter your ZIP code and answer a few quick questions about your system.',
  },
  {
    title: 'Choose a time window',
    text: 'Only real openings show up. Your confirmation has a link to reschedule or cancel.',
  },
  {
    title: 'We come to you',
    text: 'A technician arrives within the window you picked.',
  },
  {
    title: 'Back to comfortable',
    text: 'Your technician finds the fault and fixes it. You pay when the job is done.',
  },
]

// The About text as paragraphs: a blank line in the form starts a new one.
export function paragraphs(text: string): Html[] {
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== '')
    .map((paragraph) => html`<p>${paragraph}</p>`)
}
