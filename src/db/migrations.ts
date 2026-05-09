import knex from 'knex'
import dotenv from 'dotenv'

dotenv.config()

export const db = knex({
  client: 'pg',
  connection: {
    host:     process.env.DB_HOST     || 'localhost',
    port:     Number(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME     || 'trustledger',
    user:     process.env.DB_USER     || 'postgres',
    password: String(process.env.DB_PASSWORD),
  },
  pool: { min: 2, max: 10 }
})
export const runMigrations = async () => {

  // 1. USERS
  const hasUsers = await db.schema.hasTable('users')
  if (!hasUsers) {
    await db.schema.createTable('users', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'))
      t.string('display_name').nullable()
      t.decimal('balance', 18, 8).notNullable().defaultTo(0)
      t.string('reputation').notNullable().defaultTo('new')
      t.timestamps(true, true)
    })
    console.log('✅ users table created')
  }

  // 2. PASSKEYS
  const hasPasskeys = await db.schema.hasTable('passkeys')
  if (!hasPasskeys) {
    await db.schema.createTable('passkeys', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'))
      t.uuid('user_id').notNullable().references('id').inTable('users')
      t.string('credential_id').notNullable().unique()
      t.text('public_key').notNullable()
      t.bigInteger('counter').notNullable().defaultTo(0)
      t.string('device_type').nullable()
      t.timestamps(true, true)
    })
    console.log('✅ passkeys table created')
  }

  // 3. MERCHANTS
  const hasMerchants = await db.schema.hasTable('merchants')
  if (!hasMerchants) {
    await db.schema.createTable('merchants', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'))
      t.string('name').notNullable()
      t.string('api_key').notNullable().unique()
      t.decimal('balance', 18, 8).notNullable().defaultTo(0)
      t.decimal('total_earned', 18, 8).notNullable().defaultTo(0)
      t.boolean('active').notNullable().defaultTo(true)
      t.timestamps(true, true)
    })
    console.log('✅ merchants table created')
  }

  // 4. ENDPOINTS
  const hasEndpoints = await db.schema.hasTable('endpoints')
  if (!hasEndpoints) {
    await db.schema.createTable('endpoints', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'))
      t.uuid('merchant_id').notNullable().references('id').inTable('merchants')
      t.string('path').notNullable()
      t.decimal('price', 18, 8).notNullable()
      t.boolean('active').notNullable().defaultTo(true)
      t.timestamps(true, true)
    })
    console.log('✅ endpoints table created')
  }

  // 5. LEDGER — append only, never update never delete
  const hasLedger = await db.schema.hasTable('ledger')
  if (!hasLedger) {
    await db.schema.createTable('ledger', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'))
      t.uuid('user_id').notNullable().references('id').inTable('users')
      t.uuid('merchant_id').notNullable().references('id').inTable('merchants')
      t.uuid('endpoint_id').notNullable().references('id').inTable('endpoints')
      t.decimal('amount', 18, 8).notNullable()
      t.decimal('platform_fee', 18, 8).notNullable()
      t.decimal('merchant_receives', 18, 8).notNullable()
      t.decimal('user_balance_after', 18, 8).notNullable()
      t.string('status').notNullable().defaultTo('completed')
      t.timestamp('created_at').notNullable().defaultTo(db.fn.now())
    })
    console.log('✅ ledger table created')
  }

  // 6. TOPUPS
  const hasTopups = await db.schema.hasTable('topups')
  if (!hasTopups) {
    await db.schema.createTable('topups', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'))
      t.uuid('user_id').notNullable().references('id').inTable('users')
      t.decimal('amount', 18, 8).notNullable()
      t.string('stripe_payment_id').notNullable().unique()
      t.string('status').notNullable().defaultTo('pending')
      t.timestamp('created_at').notNullable().defaultTo(db.fn.now())
    })
    console.log('✅ topups table created')
  }

  // 7. CHALLENGES — one-time WebAuthn challenges (expire in 5 minutes)
  const hasChallenges = await db.schema.hasTable('challenges')
  if (!hasChallenges) {
    await db.schema.createTable('challenges', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'))
      t.string('challenge').notNullable().unique()
      t.string('type').notNullable()
      t.uuid('user_id').nullable()
      t.timestamp('expires_at').notNullable()
      t.timestamp('created_at').notNullable().defaultTo(db.fn.now())
    })
    console.log('✅ challenges table created')
  }


  console.log('✅ All tables ready')
}