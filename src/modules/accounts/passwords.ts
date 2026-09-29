import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

// OWASP parameters for scrypt: N=2^14, r=8, p=5 (16 MiB per hash).
const COST = 16384
const BLOCK_SIZE = 8
const PARALLELISM = 5
const KEY_LENGTH = 64

// Stored as "scrypt$N$r$p$salt$key", so old hashes keep working if the parameters change.
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await deriveKey(password, salt, COST, BLOCK_SIZE, PARALLELISM)
  return [
    'scrypt',
    COST,
    BLOCK_SIZE,
    PARALLELISM,
    salt.toString('base64'),
    key.toString('base64'),
  ].join('$')
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algorithm, cost, blockSize, parallelism, salt, key] = stored.split('$')
  if (algorithm !== 'scrypt' || !salt || !key) return false
  const expected = Buffer.from(key, 'base64')
  const actual = await deriveKey(
    password,
    Buffer.from(salt, 'base64'),
    Number(cost),
    Number(blockSize),
    Number(parallelism),
  )
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function deriveKey(
  password: string,
  salt: Buffer,
  N: number,
  r: number,
  p: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, { N, r, p }, (error, key) =>
      error ? reject(error) : resolve(key),
    )
  })
}
