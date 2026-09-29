import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'

// Runs once before all test files: brings the test database to the latest migration.
export default async function setup() {
  const connectionString = process.env.TEST_DATABASE_URL
  if (!connectionString) throw new Error('Set TEST_DATABASE_URL in .env (see .env.example)')
  const pool = new Pool({ connectionString })
  await migrate(drizzle({ client: pool }), { migrationsFolder: 'drizzle' })
  await pool.end()
}
