import type { BRANDING_ASSET_TYPES, PROFILE_PHOTO_TYPES } from '../db/schema.ts'

type PhotoType = (typeof PROFILE_PHOTO_TYPES)[number]
type BrandingAssetType = (typeof BRANDING_ASSET_TYPES)[number]

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

const startsWith = (bytes: Buffer, signature: number[], offset = 0) =>
  signature.every((byte, index) => bytes[offset + index] === byte)

// What an upload really is, read from its first bytes. The Content-Type header is only the
// sender's claim, and the type saved here is the one the photo is later served with.
export function photoTypeOf(bytes: Buffer): PhotoType | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(bytes, PNG_SIGNATURE)) return 'image/png'
  // 'RIFF', four size bytes, then 'WEBP'
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8))
    return 'image/webp'
  return null
}

// A logo or favicon: a PNG, or an SVG.
export function brandingAssetTypeOf(bytes: Buffer): BrandingAssetType | null {
  if (startsWith(bytes, PNG_SIGNATURE)) return 'image/png'
  return svgText(bytes) === null ? null : 'image/svg+xml'
}

// An SVG has no signature, so it's recognised by its text: valid UTF-8 that starts with
// `<svg` or an XML prolog and has an svg element. Returns that text, BOM and leading
// whitespace removed, or null.
export function svgText(bytes: Buffer): string | null {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
  const start = text.replace(/^﻿/, '').trimStart()
  if (!start.startsWith('<svg') && !start.startsWith('<?xml')) return null
  return /<svg[\s>/]/i.test(start) ? start : null
}

const UNSAFE_SVG_PATTERNS = [/<script/i, /<foreignobject/i, /\son[a-z]+\s*=/i, /javascript:/i]
const HREF = /(?:xlink:)?href\s*=\s*["']?([^"'\s>]*)/gi

// Defense in depth: assets are only shown through <img> and favicons, and served with a
// sandbox policy, so a script couldn't run anyway. Refusing these keeps the stored files plain.
export function isUnsafeSvg(text: string): boolean {
  if (UNSAFE_SVG_PATTERNS.some((pattern) => pattern.test(text))) return true
  for (const [, value] of text.matchAll(HREF)) {
    if (!value.startsWith('#') && !value.startsWith('data:image/')) return true
  }
  return false
}
