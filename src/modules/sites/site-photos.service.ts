import { db } from '../../db/client.ts'
import { SITE_PHOTO_MAX_BYTES, SITE_WORK_PHOTOS_MAX } from '../../db/schema.ts'
import { HttpError } from '../../lib/http-error.ts'
import { photoTypeOf } from '../../lib/image-type.ts'
import type { SessionUser } from '../accounts/accounts.service.ts'
import * as audit from '../audit/audit.queries.ts'
import { tenantOf } from '../booking/booking.service.ts'
import * as queries from './sites.queries.ts'
import type { PhotoQuery } from './sites.schemas.ts'
import { getSiteEditor, type SiteEditor } from './sites.service.ts'

// The site's hero photo (one at a time) and work photos (up to 12). The browser shrinks
// photos before upload; this checks what actually arrived.
export async function addPhoto(
  user: SessionUser,
  query: PhotoQuery,
  bytes: Buffer,
): Promise<SiteEditor> {
  const tenantId = tenantOf(user)
  const contentType = photoTypeOf(bytes)
  const sizeOk = bytes.length >= 1 && bytes.length <= SITE_PHOTO_MAX_BYTES
  if (!sizeOk || (contentType !== 'image/jpeg' && contentType !== 'image/webp')) {
    throw new HttpError(400, 'bad_photo', 'Photos must be JPEG or WebP, up to 1 MB.')
  }

  await db.transaction(async (tx) => {
    let sortOrder = 0
    if (query.kind === 'hero') {
      // A new hero replaces the old one.
      await queries.deleteHeroPhoto(tenantId, tx)
    } else {
      sortOrder = await queries.countWorkPhotos(tenantId, tx)
      if (sortOrder >= SITE_WORK_PHOTOS_MAX) {
        throw new HttpError(
          409,
          'too_many_photos',
          'You can show up to 12 work photos. Delete one first.',
        )
      }
    }
    const photoId = await queries.insertPhoto(
      tenantId,
      {
        kind: query.kind,
        contentType,
        data: bytes,
        altText: query.alt,
        sortOrder,
        createdBy: user.id,
      },
      tx,
    )
    await audit.insertUserAction(
      tenantId,
      {
        actorUserId: user.id,
        action: 'site.photo_added',
        entityType: 'site_photo',
        entityId: photoId,
      },
      tx,
    )
  })
  return getSiteEditor(tenantId)
}

export async function deletePhoto(user: SessionUser, photoId: string): Promise<SiteEditor> {
  const tenantId = tenantOf(user)
  const found = await queries.deletePhoto(tenantId, photoId)
  if (!found) throw new HttpError(404, 'not_found', 'Photo not found.')
  await audit.insertUserAction(tenantId, {
    actorUserId: user.id,
    action: 'site.photo_deleted',
    entityType: 'site_photo',
    entityId: photoId,
  })
  return getSiteEditor(tenantId)
}
