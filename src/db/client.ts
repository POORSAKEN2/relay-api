import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { env } from '../config/env.ts'
import { logger } from '../lib/logger.ts'

export const pool = new Pool({ connectionString: env.DATABASE_URL })

// An idle connection dropped by the server is replaced on the next query; just log it.
pool.on('error', (error) => logger.error({ err: error }, 'Postgres pool error'))

export const db = drizzle({ client: pool })

// A transaction, for queries that must run inside one. `Db` is either the pool or a transaction.
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
export type Db = typeof db | Tx
