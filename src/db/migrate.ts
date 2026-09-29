import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { db, pool } from './client.ts'

await migrate(db, { migrationsFolder: 'drizzle' })
await pool.end()
console.log('Migrations applied')
