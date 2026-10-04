import { createHash, randomBytes } from 'node:crypto'

// Private links sent in texts, like a homeowner's link to change or cancel their visit. Only
// the hash is stored, as for sessions: someone who reads the database can't use the links.
// 18 random bytes is far beyond guessing and keeps the link short in a text.
export function newLinkToken() {
  const token = randomBytes(18).toString('base64url')
  return { token, hash: hashLinkToken(token) }
}

export function hashLinkToken(token: string) {
  return createHash('sha256').update(token).digest('hex')
}
