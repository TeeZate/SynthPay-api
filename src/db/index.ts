import knex from 'knex'

// Read DATABASE_URL before any dotenv processing
const DATABASE_URL = process.env.DATABASE_URL

const connection = DATABASE_URL
  ? {
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    }
  : {
      host:     process.env.DB_HOST     || 'localhost',
      port:     Number(process.env.DB_PORT) || 5432,
      database: process.env.DB_NAME     || 'trustledger',
      user:     process.env.DB_USER     || 'postgres',
      password: String(process.env.DB_PASSWORD),
    }

export const db = knex({
  client: 'pg',
  connection,
  pool: { min: 2, max: 10 }
})

export const testConnection = async () => {
  try {
    await db.raw('SELECT 1')
    return true
  } catch {
    return false
  }
}