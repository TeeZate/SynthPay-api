import dotenv from 'dotenv'
import { resolve } from 'path'

dotenv.config({ path: resolve(process.cwd(), '.env') })

const required = [
  'DB_HOST',
  'DB_PORT',
  'DB_NAME',
  'DB_USER',
  'DB_PASSWORD',
  'JWT_SECRET',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'PLATFORM_FEE',
]

export function validateEnv() {
  const missing: string[] = []

  for (const key of required) {
    if (!process.env[key] || process.env[key] === '') {
      missing.push(key)
    }
  }

  if (missing.length > 0) {
    console.error('Missing required environment variables:')
    missing.forEach(k => console.error(`   - ${k}`))
    console.error('Server cannot start without these values.')
    process.exit(1)
  }

  console.log('Environment variables validated')
}