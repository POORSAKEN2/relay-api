import { type Html, html } from '../html.ts'
import type { SiteView } from '../site-view.ts'
import {
  BOOKING_STEPS,
  brandStyle,
  icon,
  pageHead,
  paragraphs,
  phoneDock,
  sectionLinks,
  stars,
} from './shared.ts'

// Breeze: a breeze-block screen wall that turns sun into shade. It began as the demo
// contractor's hand-written page; the brand color now fills the shade.

const FONTS =
  'https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible+Next:wght@400;700&family=Josefin+Sans:wght@600;700&display=swap'

export function renderBreeze(view: SiteView): Html {
  return html`<!doctype html>
<html lang="en" style="${brandStyle(view)}">
${pageHead(view, { css: 'breeze.css', fontsHref: FONTS })}
<body>
<a class="skip" href="#main">Skip to content</a>
${BLOCK_DRAWINGS}
${topStrip(view)}
${header(view)}
<main id="main">
${hero(view)}
${services(view)}
${emergencyBand(view)}
${howBookingWorks()}
${reviews(view)}
${workPhotos(view)}
${about(view)}
${serviceArea(view)}
${hours(view)}
${faq(view)}
${closing(view)}
</main>
${footer(view)}
${phoneDock(view)}
</body>
</html>`
}

// The clover breeze block and the wall patterns built from it.
const BLOCK_DRAWINGS = html`<svg class="defs" aria-hidden="true" focusable="false"><defs>
<g id="clover"><circle cx="21.5" cy="32" r="12.5"/><circle cx="42.5" cy="32" r="12.5"/><circle cx="32" cy="21.5" r="12.5"/><circle cx="32" cy="42.5" r="12.5"/><circle cx="32" cy="32" r="9"/></g>
<clipPath id="clover-clip"><circle cx="21.5" cy="32" r="12.5"/><circle cx="42.5" cy="32" r="12.5"/><circle cx="32" cy="21.5" r="12.5"/><circle cx="32" cy="42.5" r="12.5"/><circle cx="32" cy="32" r="9"/></clipPath>
<g id="block"><rect class="bb-mortar" width="64" height="64"/><rect class="bb-face" x="2" y="2" width="60" height="60"/><path class="bb-edge" d="M2 59h60v3H2zM59 2h3v60h-3z"/><use href="#clover" class="bb-reveal"/><g clip-path="url(#clover-clip)"><use href="#clover" class="bb-hole" x="-3" y="-3"/></g></g>
<pattern id="wall" width="64" height="64" patternUnits="userSpaceOnUse"><use href="#block"/></pattern>
<pattern id="wall-sm" width="48" height="48" patternUnits="userSpaceOnUse"><use href="#block" transform="scale(.75)"/></pattern>
</defs></svg>`

const WALL = html`<div class="wall" aria-hidden="true"><svg><rect class="wall-lg" width="100%" height="100%" fill="url(#wall)"/><rect class="wall-sm" width="100%" height="100%" fill="url(#wall-sm)"/></svg></div>`

function brandMark(view: SiteView): Html {
  if (view.logoUrl) return html`<img class="brand-logo" src="${view.logoUrl}" alt="">`
  return html`<svg class="brand-mark" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="6"/><use href="#clover"/></svg>`
}

function callButton(view: SiteView): Html {
  return html`<a class="btn btn-call" href="${view.phone.href}" aria-label="Call ${view.name} at ${view.phone.display}">${icon('phone')}<span class="only-narrow">Call now</span><span class="only-wide">${view.phone.display}</span></a>`
}

function bookButton(view: SiteView, label = 'Book online'): Html {
  return html`<a class="btn btn-book" href="${view.bookingUrl}">${icon('calendar')}${label}</a>`
}

function topStrip(view: SiteView): Html {
  const details = [...view.hours, view.licenseNumber ?? ''].filter((part) => part !== '')
  return html`<div class="strip"><div class="wrap">
<p>${view.emergency ? 'Emergency? Calls answered 24/7:' : 'Call us:'} <a href="${view.phone.href}">${view.phone.display}</a></p>
${details.length > 0 && html`<p class="strip-meta">${details.join(' · ')}</p>`}
</div></div>`
}

function header(view: SiteView): Html {
  const links = sectionLinks(view).map(
    (link) => html`<li><a href="${link.href}">${link.label}</a></li>`,
  )
  return html`<header class="header"><div class="wrap">
<a class="brand" href="#top" aria-label="${view.name}, home">${brandMark(view)}<span class="brand-name">${view.name}</span></a>
<nav class="nav" id="site-nav" aria-label="Main"><ul>${links}</ul></nav>
<a class="header-call" href="${view.phone.href}">${icon('phone')}${view.phone.display}</a>
<a class="btn btn-book header-book" href="${view.bookingUrl}">Book online</a>
<button class="menu-btn" type="button" aria-expanded="false" aria-controls="site-nav" data-menu-button>${icon('menu')}Menu</button>
</div></header>`
}

function hero(view: SiteView): Html {
  const claims = view.claims.map((claim) => html`<li>${claim}</li>`)
  return html`<section class="hero" id="top" aria-labelledby="hero-title">
${WALL}
<div class="shade">
<div class="cast" data-cast aria-hidden="true"></div>
<div class="wrap hero-body">
<div>
<h1 id="hero-title">${view.headline}</h1>
<p class="hero-sub">${view.intro}</p>
<div class="actions" data-watch-actions>${bookButton(view)}${callButton(view)}</div>
${claims.length > 0 && html`<ul class="trust">${claims}</ul>`}
</div>
${view.heroPhoto && html`<img class="hero-photo" src="${view.heroPhoto.url}" alt="${view.heroPhoto.alt}">`}
</div>
</div>
</section>`
}

function services(view: SiteView): Html | null {
  if (view.services.length === 0) return null
  const items = view.services.map(
    (service) => html`<li>
<div class="service-name"><h3>${service.name}</h3>${service.price && html`<span class="price">${service.price}</span>`}</div>
${service.description && html`<p>${service.description}</p>`}
</li>`,
  )
  return html`<section class="section plain" id="services" aria-labelledby="services-title"><div class="wrap">
<div class="section-head"><h2 id="services-title">What we fix, install and keep running</h2><p>Book any of these online, or call and we’ll help you pick.</p></div>
<ul class="service-list">${items}</ul>
<div class="services-cta"><p>Not sure what’s wrong? Book a visit and we’ll find it.</p>${bookButton(view)}</div>
</div></section>`
}

function emergencyBand(view: SiteView): Html | null {
  if (!view.emergency) return null
  return html`<section class="urgent" aria-labelledby="urgent-title"><div class="wrap">
<h2 id="urgent-title">24/7 emergency service</h2>
<p>No cooling or no heat? Call any hour, day or night.</p>
<a class="phone-big" href="${view.phone.href}">${icon('phone')}${view.phone.display}</a>
</div></section>`
}

function howBookingWorks(): Html {
  const steps = BOOKING_STEPS.map(
    (step, index) =>
      html`<li><span class="step-number">${index + 1}</span><h3>${step.title}</h3><p>${step.text}</p></li>`,
  )
  return html`<section class="shade section" id="how" aria-labelledby="how-title"><div class="wrap">
<div class="section-head"><h2 id="how-title">Book online in about two minutes</h2><p>The booking page shows real openings, so the time you pick is the time we come.</p></div>
<ol class="timeline">${steps}</ol>
</div></section>`
}

function reviews(view: SiteView): Html | null {
  if (view.reviews.length === 0) return null
  const items = view.reviews.map(
    (review) => html`<li><figure>
${stars(review.rating)}
<blockquote><p>${review.body}</p></blockquote>
<figcaption>${review.authorName}${review.place && html` · ${review.place}`}</figcaption>
</figure></li>`,
  )
  return html`<section class="door section" id="reviews" aria-labelledby="reviews-title"><div class="wrap">
<div class="section-head"><h2 id="reviews-title">What customers say</h2></div>
<ul class="reviews">${items}</ul>
</div></section>`
}

function workPhotos(view: SiteView): Html | null {
  if (view.workPhotos.length === 0) return null
  const items = view.workPhotos.map(
    (photo) => html`<li><img src="${photo.url}" alt="${photo.alt}" loading="lazy"></li>`,
  )
  return html`<section class="section plain" id="photos" aria-labelledby="photos-title"><div class="wrap">
<div class="section-head"><h2 id="photos-title">Recent work</h2></div>
<ul class="gallery">${items}</ul>
</div></section>`
}

function about(view: SiteView): Html | null {
  if (!view.about) return null
  return html`<section class="section plain" id="about" aria-labelledby="about-title"><div class="wrap split">
<h2 id="about-title">About ${view.name}</h2>
<div class="about-text">${paragraphs(view.about)}</div>
</div></section>`
}

function serviceArea(view: SiteView): Html | null {
  if (view.citiesServed.length === 0) return null
  const cities = view.citiesServed.map((city) => html`<li>${city}</li>`)
  return html`<section class="section plain" id="area" aria-labelledby="area-title"><div class="wrap area-grid">
<div class="area-copy">
<h2 id="area-title">Where we work</h2>
<p>Not sure we reach you? The booking page checks your ZIP code before you pick a time.</p>
${bookButton(view, 'Check your ZIP and book')}
</div>
<ul class="area-wall">${cities}</ul>
</div></section>`
}

function hours(view: SiteView): Html | null {
  if (view.hours.length === 0) return null
  const lines = view.hours.map((line) => html`<li>${line}</li>`)
  return html`<section class="section plain" id="hours" aria-labelledby="hours-title"><div class="wrap split">
<h2 id="hours-title">Office hours</h2>
<ul class="hours-list">${lines}${view.emergency && html`<li>Emergency calls: any hour</li>`}</ul>
</div></section>`
}

function faq(view: SiteView): Html | null {
  if (view.faqs.length === 0) return null
  const items = view.faqs.map(
    (item) => html`<details><summary>${item.question}</summary><p>${item.answer}</p></details>`,
  )
  return html`<section class="section plain" id="faq" aria-labelledby="faq-title"><div class="wrap split">
<h2 id="faq-title">Questions we hear a lot</h2>
<div class="faq-list">${items}</div>
</div></section>`
}

function closing(view: SiteView): Html {
  return html`<section class="final" id="book" aria-labelledby="final-title">
${WALL}
<div class="shade">
<div class="cast" data-cast aria-hidden="true"></div>
<div class="wrap final-body">
<h2 id="final-title">Get your home comfortable again.</h2>
<p>Book a time online now, or call and talk it through with us.</p>
<div class="actions" data-watch-actions>${bookButton(view)}${callButton(view)}</div>
</div>
</div>
</section>`
}

function footer(view: SiteView): Html {
  const links = sectionLinks(view).map(
    (link) => html`<li><a href="${link.href}">${link.label}</a></li>`,
  )
  return html`<footer class="footer"><div class="wrap footer-grid">
<div class="footer-brand">
<a class="brand" href="#top" aria-label="${view.name}, back to top"><span class="brand-name">${view.name}</span></a>
<p>Heating and cooling in ${view.place}.</p>
</div>
<div><p class="footer-title">Contact</p><ul class="footer-list">
<li><a href="${view.phone.href}">${view.phone.display}</a></li>
<li>${view.place}</li>
${view.hours.map((line) => html`<li>${line}</li>`)}
${view.emergency && html`<li>Emergency calls: any hour</li>`}
</ul></div>
<div><p class="footer-title">Explore</p><ul class="footer-list">${links}<li><a href="${view.bookingUrl}">Book online</a></li></ul></div>
</div>
<div class="wrap footer-legal">
<p>© <span data-year>${new Date().getFullYear()}</span> ${view.name}${view.licenseNumber && html` · ${view.licenseNumber}`}</p>
<p>Online booking by Relay</p>
</div>
</footer>`
}
