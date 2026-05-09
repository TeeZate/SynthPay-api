const { Client } = require('pg')

const client = new Client({
  connectionString: process.env.DATABASE_URL ||
    'postgresql://postgres:eajKeAQopjDrchwqYfNYZkcuolwryQTi@roundhouse.proxy.rlwy.net:26971/railway',
  ssl: { rejectUnauthorized: false }
})

async function migrate() {
  await client.connect()
  console.log('Connected')

  // Add idempotency_key column to topups
  await client.query(`
    ALTER TABLE topups
    ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(255)
  `)
  console.log('Added idempotency_key column')

  // Add UNIQUE constraint — this is the mathematical guarantee
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS topups_idempotency_key_unique
    ON topups (idempotency_key)
    WHERE idempotency_key IS NOT NULL
  `)
  console.log('Added UNIQUE index on idempotency_key')

  await client.end()
  console.log('Migration complete — double charges are now impossible')
}

migrate().catch(err => {
  console.error('Failed:', err.message)
  process.exit(1)
})
