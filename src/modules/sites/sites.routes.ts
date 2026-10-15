import * as Sentry from '@sentry/node'
import { Router } from 'express'
import { env } from '../../config/env.ts'
import { HttpError } from '../../lib/http-error.ts'
import { logger } from '../../lib/logger.ts'
import { ERROR_PAGE, NOT_FOUND_PAGE } from './designs/system-pages.ts'
import { findAsset } from './site-assets.ts'
import { parseSiteHost } from './site-host.ts'
import { PhotoParams } from './sites.schemas.ts'
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
