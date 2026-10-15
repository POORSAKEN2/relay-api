import * as Sentry from '@sentry/node'
import express, { Router } from 'express'
import { env } from '../../config/env.ts'
import { HttpError } from '../../lib/http-error.ts'
import { logger } from '../../lib/logger.ts'
import { requireRole } from '../../middleware/auth.ts'
import { tenantOf } from '../booking/booking.service.ts'
import { ERROR_PAGE, NOT_FOUND_PAGE } from './designs/system-pages.ts'
import { findAsset } from './site-assets.ts'
import { parseSiteHost } from './site-host.ts'
import * as lists from './site-lists.service.ts'
import * as photos from './site-photos.service.ts'
import {
  FaqInput,
  FaqParams,
  OrderInput,
  PhotoParams,
  PhotoQuery,
  ReviewInput,
  ReviewParams,
  SiteInput,
} from './sites.schemas.ts'
import * as sites from './sites.service.ts'

// The contractor's website, on its own host: desert.site.garified.com. Any other host, and
// /api/ on a site host (the site's stylesheet, script and photos), carries on to the app.
export const siteHostRoutes = Router()

siteHostRoutes.use(async (req, res, next) => {
  const host = parseSiteHost(req.hostname ?? '', env.APP_DOMAIN)
  if (!host || req.path.startsWith('/api/')) {
    next()
    return
  }
  res.type('html')
  if (req.path !== '/' || (req.method !== 'GET' && req.method !== 'HEAD')) {
    res.status(404).set('Cache-Control', 'no-store').send(NOT_FOUND_PAGE)
    return
  }
  try {
    const page = await sites.renderPublicPage(host.slug)
    if (!page) {
      res.status(404).set('Cache-Control', 'no-store').send(NOT_FOUND_PAGE)
      return
    }
    // no-cache: the browser checks back every time, so an edit shows on the next reload.
    res.set('Cache-Control', 'no-cache').send(page)
  } catch (err) {
    // A bare page for the visitor; the details go to the log and Sentry, never to the page.
    logger.error({ err, requestId: req.id }, 'Site page failed')
    Sentry.captureException(err)
    res.status(500).set('Cache-Control', 'no-store').send(ERROR_PAGE)
  }
})

export const sitesRoutes = Router()

// Editing the site: the Website page in the dashboard.

const staff = requireRole('owner', 'office')

sitesRoutes.get('/site', staff, async (req, res) => {
  res.json(await sites.getSiteEditor(tenantOf(req.user!)))
})

sitesRoutes.put('/site', staff, async (req, res) => {
  const input = SiteInput.parse(req.body)
  res.json(await sites.saveSite(req.user!, input))
})

sitesRoutes.post('/site/publish', staff, async (req, res) => {
  res.json(await sites.publishSite(req.user!))
})

sitesRoutes.post('/site/unpublish', staff, async (req, res) => {
  res.json(await sites.unpublishSite(req.user!))
})

// Shown in an iframe next to the form; reloaded after each save, so never cached.
sitesRoutes.get('/site/preview', staff, async (req, res) => {
  const page = await sites.renderPreview(tenantOf(req.user!))
  res.type('html').set('Cache-Control', 'no-store').send(page)
})

// Reviews and questions. Each `/order` route comes before its `/:id` route, so "order" is
// never read as an id.

sitesRoutes.post('/site/reviews', staff, async (req, res) => {
  res.json(await lists.addReview(req.user!, ReviewInput.parse(req.body)))
})

sitesRoutes.put('/site/reviews/order', staff, async (req, res) => {
  const { ids } = OrderInput.parse(req.body)
  res.json(await lists.reorderReviews(req.user!, ids))
})

sitesRoutes.put('/site/reviews/:reviewId', staff, async (req, res) => {
  const { reviewId } = ReviewParams.parse(req.params)
  res.json(await lists.updateReview(req.user!, reviewId, ReviewInput.parse(req.body)))
})

sitesRoutes.delete('/site/reviews/:reviewId', staff, async (req, res) => {
  const { reviewId } = ReviewParams.parse(req.params)
  res.json(await lists.deleteReview(req.user!, reviewId))
})

sitesRoutes.post('/site/faqs', staff, async (req, res) => {
  res.json(await lists.addFaq(req.user!, FaqInput.parse(req.body)))
})

sitesRoutes.put('/site/faqs/order', staff, async (req, res) => {
  const { ids } = OrderInput.parse(req.body)
  res.json(await lists.reorderFaqs(req.user!, ids))
})

sitesRoutes.put('/site/faqs/:faqId', staff, async (req, res) => {
  const { faqId } = FaqParams.parse(req.params)
  res.json(await lists.updateFaq(req.user!, faqId, FaqInput.parse(req.body)))
})

sitesRoutes.delete('/site/faqs/:faqId', staff, async (req, res) => {
  const { faqId } = FaqParams.parse(req.params)
  res.json(await lists.deleteFaq(req.user!, faqId))
})

// Photos. The image is the request body itself. The limit sits above the 1 MB the service
// allows, so an oversized photo gets the service's clear message, not Express's 413.
const photoBody = express.raw({ type: () => true, limit: '2mb' })

sitesRoutes.post('/site/photos', staff, photoBody, async (req, res) => {
  const query = PhotoQuery.parse(req.query)
  // With no body, express.raw leaves req.body unset: treat it as an empty photo.
  const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
  res.json(await photos.addPhoto(req.user!, query, bytes))
})

sitesRoutes.delete('/site/photos/:photoId', staff, async (req, res) => {
  const { photoId } = PhotoParams.parse(req.params)
  res.json(await photos.deletePhoto(req.user!, photoId))
})

// Public: the site's files.

const CACHE_FOR_A_YEAR = 'public, max-age=31536000, immutable'

// The site's stylesheets and script. The URL carries a content hash, so caching for a year is safe.
sitesRoutes.get('/site/assets/:file', (req, res) => {
  const asset = findAsset(req.params.file)
  if (!asset) throw new HttpError(404, 'not_found', 'File not found.')
  res.set({ 'Content-Type': asset.contentType, 'Cache-Control': CACHE_FOR_A_YEAR }).send(asset.body)
})

// Public, like branding images: an <img> on the site can't send a session.
sitesRoutes.get('/site/photos/:photoId', async (req, res) => {
  const { photoId } = PhotoParams.parse(req.params)
  const photo = await sites.getPhoto(photoId)
  res
    .set({
      'Content-Type': photo.contentType,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': CACHE_FOR_A_YEAR,
      'Cross-Origin-Resource-Policy': 'cross-origin',
    })
    .send(photo.data)
})
