import type { Response } from 'express'

// Sends a stored photo. `nosniff` keeps browsers to the type that was checked on upload. A
// photo's URL always points at the same bytes, so browsers may keep it.
export function sendPhoto(res: Response, photo: { contentType: string; data: Buffer }) {
  res
    .set({
      'Content-Type': photo.contentType,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=31536000, immutable',
    })
    .send(photo.data)
}
