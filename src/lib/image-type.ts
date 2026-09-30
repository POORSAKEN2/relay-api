import type { PROFILE_PHOTO_TYPES } from '../db/schema.ts'

type PhotoType = (typeof PROFILE_PHOTO_TYPES)[number]

const startsWith = (bytes: Buffer, signature: number[], offset = 0) =>
  signature.every((byte, index) => bytes[offset + index] === byte)

// What an upload really is, read from its first bytes. The Content-Type header is only the
// sender's claim, and the type saved here is the one the photo is later served with.
export function photoTypeOf(bytes: Buffer): PhotoType | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  // 'RIFF', four size bytes, then 'WEBP'
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8))
    return 'image/webp'
  return null
}
