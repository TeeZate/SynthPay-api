const { Client } = require('pg')

const client = new Client({
  connectionString: process.env.DATABASE_URL ||
    'postgresql://postgres:eajKeAQopjDrchwqYfNYZkcuolwryQTi@roundhouse.proxy.rlwy.net:26971/railway',
  ssl: { rejectUnauthorized: false }
})

async function migrate() {
  await client.connect()
  console.log('Connected')

  // Add email column to users table
  await client.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS email VARCHAR(255) UNIQUE
  `)
  console.log('Added email column to users')

  // Create email_otps table
  await client.query(`
    CREATE TABLE IF NOT EXISTS email_otps (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email      VARCHAR(255) NOT NULL,
      user_id    UUID NOT NULL REFERENCES users(id),
      otp        VARCHAR(6) NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used       BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  console.log('Created email_otps table')

  // Index for fast lookup
  await client.query(`
    CREATE INDEX IF NOT EXISTS email_otps_email_idx ON email_otps (email)
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS email_otps_user_id_idx ON email_otps (user_id)
  `)
  console.log('Created indexes')

  await client.end()
  console.log('Migration complete')
}

migrate().catch(err => {
  console.error('Failed:', err.message)
  process.exit(1)
})
