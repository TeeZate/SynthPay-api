// Run with: node add-service-fields.js
import pg from 'pg'

const { Client } = pg

const client = new Client({
  connectionString: process.env.DATABASE_URL || 
    'postgresql://railway:eajKeAQopjDrchwqYfNYZkcuolwryQTi@roundhouse.proxy.rlwy.net:26971/railway'
})

async function migrate() {
  await client.connect()
  console.log('Connected to database')

  await client.query(`
    ALTER TABLE endpoints
    ADD COLUMN IF NOT EXISTS service_name  VARCHAR(255),
    ADD COLUMN IF NOT EXISTS description   VARCHAR(500),
    ADD COLUMN IF NOT EXISTS category      VARCHAR(100)
  `)
  console.log('✓ Added service_name, description, category to endpoints')

  // Update existing Tanya Nursery endpoint
  await client.query(`
    UPDATE endpoints
    SET 
      service_name = 'Nursery Rhymes',
      description  = 'Classic nursery rhymes on demand. Perfect for kids apps and educational platforms.',
      category     = 'Education'
    WHERE path = '/api/nursery-rhymes'
  `)
  console.log('✓ Updated Tanya Nursery endpoint with service details')

  // Update any other existing endpoints with defaults
  await client.query(`
    UPDATE endpoints
    SET
      service_name = COALESCE(service_name, path),
      description  = COALESCE(description, 'API service'),
      category     = COALESCE(category, 'General')
    WHERE service_name IS NULL
  `)
  console.log('✓ Set defaults for all existing endpoints')

  await client.end()
  console.log('Migration complete')
}

migrate().catch(err => {
  console.error('Migration failed:', err)
  process.exit(1)
})