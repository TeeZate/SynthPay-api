import knex from 'knex'
import dotenv from 'dotenv'
import { createHash } from 'crypto'

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
      t.string('service_name').nullable()
      t.text('description').nullable()
      t.string('category').nullable().defaultTo('General')
      t.timestamps(true, true)
    })
    console.log('✅ endpoints table created')
  } else {
    // Add missing columns to existing endpoints table
    const hasServiceName = await db.schema.hasColumn('endpoints', 'service_name')
    if (!hasServiceName) {
      await db.schema.alterTable('endpoints', (t) => {
        t.string('service_name').nullable()
        t.text('description').nullable()
        t.string('category').nullable().defaultTo('General')
      })
      console.log('✅ endpoints: added service_name, description, category columns')
    }
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
      t.string('provider').notNullable().defaultTo('stripe')
      t.string('currency').notNullable().defaultTo('USD')
      t.string('payment_ref').nullable().unique()
      t.timestamp('created_at').notNullable().defaultTo(db.fn.now())
    })
    console.log('✅ topups table created')
  } else {
    // Idempotent: add provider/currency/payment_ref if missing (existing deployments)
    const hasProvider = await db.schema.hasColumn('topups', 'provider')
    if (!hasProvider) {
      await db.schema.alterTable('topups', (t) => {
        t.string('provider').notNullable().defaultTo('stripe')
        t.string('currency').notNullable().defaultTo('USD')
        t.string('payment_ref').nullable()
      })
      console.log('✅ topups: added provider/currency/payment_ref columns')
    }
  }

  // 7. PAYOUTS — merchant withdrawal records
  const hasPayouts = await db.schema.hasTable('payouts')
  if (!hasPayouts) {
    await db.schema.createTable('payouts', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'))
      t.uuid('merchant_id').notNullable().references('id').inTable('merchants')
      t.decimal('amount', 18, 8).notNullable()
      t.string('method').notNullable().defaultTo('bank_transfer') // bank_transfer | mobile_money | stripe_connect
      t.string('status').notNullable().defaultTo('pending')       // pending | completed | failed
      t.string('stripe_transfer_id').nullable().unique()
      t.jsonb('payout_details').nullable()   // bank details / phone / etc — varies by method
      t.text('notes').nullable()
      t.timestamp('created_at').notNullable().defaultTo(db.fn.now())
      t.timestamp('updated_at').notNullable().defaultTo(db.fn.now())
    })
    console.log('✅ payouts table created')
  }

  // 6b. LEDGER — add entry_hash / prev_hash columns (existing deployments)
  const hasEntryHash = await db.schema.hasColumn('ledger', 'entry_hash')
  if (!hasEntryHash) {
    await db.schema.alterTable('ledger', (t) => {
      t.text('entry_hash').nullable()
      t.text('prev_hash').nullable()
    })
    console.log('✅ ledger: added entry_hash, prev_hash columns')

    // Backfill all existing entries in chronological order
    const entries = await db('ledger').orderBy('created_at', 'asc').select('*')
    let previousHash = '0000000000000000'
    for (const entry of entries) {
      const amount = Number(entry.amount)
      const fee    = Number(entry.platform_fee)
      const data   = `${entry.id}|${entry.user_id}|${entry.merchant_id}|${amount}|${fee}|${entry.created_at}|${previousHash}`
      const hash   = createHash('sha256').update(data).digest('hex')
      await db('ledger').where({ id: entry.id }).update({ entry_hash: hash, prev_hash: previousHash })
      previousHash = hash
    }
    console.log(`✅ ledger: backfilled entry_hash for ${entries.length} existing entries`)
  }

  // 7b. MERCHANTS — add missing columns (existing deployments)
  const hasMerchantEmail = await db.schema.hasColumn('merchants', 'email')
  if (!hasMerchantEmail) {
    await db.schema.alterTable('merchants', (t) => {
      t.string('email').nullable()
      t.string('stripe_account_id').nullable()
      t.string('payout_method').notNullable().defaultTo('bank_transfer')
    })
    console.log('✅ merchants: added email, stripe_account_id, payout_method columns')
  }

  // 8. CHALLENGES — one-time WebAuthn challenges (expire in 5 minutes)
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