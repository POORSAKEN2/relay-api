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

// Clean: light and photo-led. The hero photo fills the right half of the first screen; with
// no photo, a brand-colored panel lettered like a service van's door takes its place.
// Barlow comes from road and vehicle signage, which suits a trade that lives in its vans.

const FONTS =
  'https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600&family=Barlow+Semi+Condensed:wght@600&display=swap'

export function renderClean(view: SiteView): Html {
  return html`<!doctype html>
<html lang="en" style="${brandStyle(view)}">
${pageHead(view, { css: 'clean.css', fontsHref: FONTS })}
<body>
<a class="skip" href="#main">Skip to content</a>
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

function bookButton(view: SiteView, label = 'Book online'): Html {
  return html`<a class="btn btn-book" href="${view.bookingUrl}">${icon('calendar')}${label}</a>`
}

function callButton(view: SiteView): Html {
  return html`<a class="btn btn-call" href="${view.phone.href}" aria-label="Call ${view.name} at ${view.phone.display}">${icon('phone')}${view.phone.display}</a>`
}

function header(view: SiteView): Html {
  const links = sectionLinks(view).map(
    (link) => html`<li><a href="${link.href}">${link.label}</a></li>`,
  )
  return html`<header class="header"><div class="wrap">
<a class="brand" href="#top" aria-label="${view.name}, home">${view.logoUrl && html`<img class="brand-logo" src="${view.logoUrl}" alt="">`}<span class="brand-name">${view.name}</span></a>
<nav class="nav" id="site-nav" aria-label="Main"><ul>${links}</ul></nav>
<a class="header-call" href="${view.phone.href}">${icon('phone')}${view.phone.display}</a>
<a class="btn btn-book header-book" href="${view.bookingUrl}">Book online</a>
<button class="menu-btn" type="button" aria-expanded="false" aria-controls="site-nav" data-menu-button>${icon('menu')}Menu</button>
</div></header>`
}

function hero(view: SiteView): Html {
  const claims = view.claims.map((claim) => html`<li>${claim}</li>`)
  const picture = view.heroPhoto
    ? html`<img class="hero-photo" src="${view.heroPhoto.url}" alt="${view.heroPhoto.alt}">`
    : html`<div class="van-door" aria-hidden="true">
<p class="van-name">${view.name}</p>
<p class="van-phone">${view.phone.display}</p>
<p class="van-place">${view.place}</p>
</div>`
  return html`<section class="hero" id="top" aria-labelledby="hero-title">
<div class="hero-text">
<h1 id="hero-title">${view.headline}</h1>
<p class="hero-sub">${view.intro}</p>
<div class="actions" data-watch-actions>${bookButton(view)}${callButton(view)}</div>
${claims.length > 0 && html`<ul class="claims">${claims}</ul>`}
</div>
<div class="hero-picture">${picture}</div>
</section>`
}

function sectionHead(id: string, title: string, lede?: string): Html {
  return html`<div class="section-head"><h2 id="${id}-title">${title}</h2>${lede && html`<p>${lede}</p>`}</div>`
}

function services(view: SiteView): Html | null {
  if (view.services.length === 0) return null
  const items = view.services.map(
    (service) => html`<li>
<h3>${service.name}</h3>
${service.price && html`<p class="price">${service.price}</p>`}
${service.description && html`<p class="service-text">${service.description}</p>`}
</li>`,
  )
  return html`<section class="section" id="services" aria-labelledby="services-title"><div class="wrap">
${sectionHead('services', 'What we do', 'Book any of these online, or call and we’ll help you pick.')}
<ul class="service-list">${items}</ul>
</div></section>`
}

function emergencyBand(view: SiteView): Html | null {
  if (!view.emergency) return null
  return html`<section class="emergency" aria-labelledby="emergency-title"><div class="wrap">
<h2 id="emergency-title">24/7 emergency service</h2>
<p>No cooling or no heat? Call any hour, day or night.</p>
<a class="emergency-phone" href="${view.phone.href}">${icon('phone')}${view.phone.display}</a>
</div></section>`
}

function howBookingWorks(): Html {
  const steps = BOOKING_STEPS.map(
    (step) => html`<li><h3>${step.title}</h3><p>${step.text}</p></li>`,
  )
  return html`<section class="section soft" id="how" aria-labelledby="how-title"><div class="wrap">
${sectionHead('how', 'Booking takes about two minutes', 'The booking page shows real openings, so the time you pick is the time we come.')}
<ol class="steps">${steps}</ol>
</div></section>`
}

function reviews(view: SiteView): Html | null {
  if (view.reviews.length === 0) return null
  const items = view.reviews.map(
    (review) => html`<li><figure>
${stars(review.rating)}
<blockquote><p>${review.body}</p></blockquote>
<figcaption>${review.authorName}${review.place && html`<span>, ${review.place}</span>`}</figcaption>
</figure></li>`,
  )
  return html`<section class="section" id="reviews" aria-labelledby="reviews-title"><div class="wrap">
${sectionHead('reviews', 'What customers say')}
<ul class="reviews">${items}</ul>
</div></section>`
}

function workPhotos(view: SiteView): Html | null {
  if (view.workPhotos.length === 0) return null
  const items = view.workPhotos.map(
    (photo) => html`<li><img src="${photo.url}" alt="${photo.alt}" loading="lazy"></li>`,
  )
  return html`<section class="section" id="photos" aria-labelledby="photos-title"><div class="wrap">
${sectionHead('photos', 'Recent work')}
<ul class="mosaic">${items}</ul>
</div></section>`
}

function about(view: SiteView): Html | null {
  if (!view.about) return null
  return html`<section class="section soft" id="about" aria-labelledby="about-title"><div class="wrap split">
<h2 id="about-title">About ${view.name}</h2>
<div class="prose">${paragraphs(view.about)}</div>
</div></section>`
}

function serviceArea(view: SiteView): Html | null {
  if (view.citiesServed.length === 0) return null
  const cities = view.citiesServed.map((city) => html`<li>${city}</li>`)
  return html`<section class="section" id="area" aria-labelledby="area-title"><div class="wrap">
${sectionHead('area', 'Where we work', 'Not sure we reach you? The booking page checks your ZIP code before you pick a time.')}
<ul class="cities">${cities}</ul>
${bookButton(view, 'Check your ZIP and book')}
</div></section>`
}

function hours(view: SiteView): Html | null {
  if (view.hours.length === 0) return null
  const lines = view.hours.map((line) => html`<li>${line}</li>`)
  return html`<section class="section" id="hours" aria-labelledby="hours-title"><div class="wrap split">
<h2 id="hours-title">Office hours</h2>
<ul class="hours-list">${lines}${view.emergency && html`<li>Emergency calls: any hour</li>`}</ul>
</div></section>`
}

function faq(view: SiteView): Html | null {
  if (view.faqs.length === 0) return null
  const items = view.faqs.map(
    (item) => html`<details><summary>${item.question}</summary><p>${item.answer}</p></details>`,
  )
  return html`<section class="section" id="faq" aria-labelledby="faq-title"><div class="wrap split">
<h2 id="faq-title">Common questions</h2>
<div class="faq-list">${items}</div>
</div></section>`
}

function closing(view: SiteView): Html {
  return html`<section class="closing" id="book" aria-labelledby="closing-title"><div class="wrap">
<h2 id="closing-title">Ready when you are.</h2>
<p>Book a time online now, or call and talk it through with us.</p>
<div class="actions" data-watch-actions>${bookButton(view)}${callButton(view)}</div>
</div></section>`
}

function footer(view: SiteView): Html {
  const links = sectionLinks(view).map(
    (link) => html`<li><a href="${link.href}">${link.label}</a></li>`,
  )
  return html`<footer class="footer"><div class="wrap footer-grid">
<div>
<p class="footer-name">${view.name}</p>
<p>${view.place}</p>
${view.licenseNumber && html`<p>${view.licenseNumber}</p>`}
</div>
<div>
<h2 class="footer-title">Contact</h2>
<ul class="footer-list">
<li><a href="${view.phone.href}">${view.phone.display}</a></li>
${view.hours.map((line) => html`<li>${line}</li>`)}
${view.emergency && html`<li>Emergency calls: any hour</li>`}
</ul>
</div>
<div>
<h2 class="footer-title">On this page</h2>
<ul class="footer-list">${links}<li><a href="${view.bookingUrl}">Book online</a></li></ul>
</div>
</div>
<div class="wrap footer-legal"><p>© <span data-year>${new Date().getFullYear()}</span> ${view.name}</p><p>Online booking by Relay</p></div>
</footer>`
}
