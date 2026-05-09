import { runMigrations, db } from './migrations'

const setup = async () => {
  try {
    console.log('🔄 Running TrustLedger database setup...')
    await runMigrations()
    console.log('✅ Database ready')
    await db.destroy()
    process.exit(0)
  } catch (err) {
    console.error('❌ Migration failed:', err)
    await db.destroy()
    process.exit(1)
  }
}

setup()