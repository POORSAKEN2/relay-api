import { createHash, randomBytes } from 'node:crypto'

// A random token for a link or a cookie. Only its hash is ever saved (hashToken).
export function newToken(bytes: number): string {
  return randomBytes(bytes).toString('base64url')
}

// What the database keeps instead of a token, so a copy of the database opens nothing.
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
