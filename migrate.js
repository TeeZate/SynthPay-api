process.env.DATABASE_URL = 'postgresql://postgres:eajKeAQopjDrchwqYfNYZkcuolwryQTi@roundhouse.proxy.rlwy.net:26971/railway';

const knex = require('knex');

const db = knex({
  client: 'pg',
  connection: {
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  }
});

async function migrate() {
  console.log('Running migrations...');
  
  await db.schema.createTableIfNotExists('users', t => {
    t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
    t.string('display_name').nullable();
    t.decimal('balance', 18, 8).notNullable().defaultTo(0);
    t.string('reputation').notNullable().defaultTo('new');
    t.timestamps(true, true);
  });
  console.log('✅ users');

  await db.schema.createTableIfNotExists('passkeys', t => {
    t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
    t.uuid('user_id').notNullable().references('id').inTable('users');
    t.string('credential_id').notNullable().unique();
    t.text('public_key').notNullable();
    t.bigInteger('counter').notNullable().defaultTo(0);
    t.string('device_type').nullable();
    t.timestamps(true, true);
  });
  console.log('✅ passkeys');

  await db.schema.createTableIfNotExists('merchants', t => {
    t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
    t.string('name').notNullable();
    t.string('api_key').notNullable().unique();
    t.decimal('balance', 18, 8).notNullable().defaultTo(0);
    t.decimal('total_earned', 18, 8).notNullable().defaultTo(0);
    t.boolean('active').notNullable().defaultTo(true);
    t.string('stripe_account_id').nullable();
    t.boolean('stripe_onboarded').notNullable().defaultTo(false);
    t.string('email').nullable();
    t.timestamps(true, true);
  });
  console.log('✅ merchants');

  await db.schema.createTableIfNotExists('endpoints', t => {
    t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
    t.uuid('merchant_id').notNullable().references('id').inTable('merchants');
    t.string('path').notNullable();
    t.decimal('price', 18, 8).notNullable();
    t.boolean('active').notNullable().defaultTo(true);
    t.timestamps(true, true);
  });
  console.log('✅ endpoints');

  await db.schema.createTableIfNotExists('ledger', t => {
    t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
    t.uuid('user_id').notNullable().references('id').inTable('users');
    t.uuid('merchant_id').notNullable().references('id').inTable('merchants');
    t.uuid('endpoint_id').notNullable().references('id').inTable('endpoints');
    t.decimal('amount', 18, 8).notNullable();
    t.decimal('platform_fee', 18, 8).notNullable();
    t.decimal('merchant_receives', 18, 8).notNullable();
    t.decimal('user_balance_after', 18, 8).notNullable();
    t.string('status').notNullable().defaultTo('completed');
    t.timestamp('created_at').notNullable().defaultTo(db.fn.now());
  });
  console.log('✅ ledger');

  await db.schema.createTableIfNotExists('topups', t => {
    t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
    t.uuid('user_id').notNullable().references('id').inTable('users');
    t.decimal('amount', 18, 8).notNullable();
    t.string('stripe_payment_id').notNullable().unique();
    t.string('status').notNullable().defaultTo('pending');
    t.timestamp('created_at').notNullable().defaultTo(db.fn.now());
  });
  console.log('✅ topups');

  await db.schema.createTableIfNotExists('challenges', t => {
    t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
    t.string('challenge').notNullable().unique();
    t.string('type').notNullable();
    t.uuid('user_id').nullable();
    t.timestamp('expires_at').notNullable();
    t.timestamp('created_at').notNullable().defaultTo(db.fn.now());
  });
  console.log('✅ challenges');

  await db.schema.createTableIfNotExists('payouts', t => {
    t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
    t.uuid('merchant_id').notNullable().references('id').inTable('merchants');
    t.decimal('amount', 18, 8).notNullable();
    t.string('stripe_transfer_id').notNullable().unique();
    t.string('status').notNullable().defaultTo('pending');
    t.timestamp('created_at').notNullable().defaultTo(db.fn.now());
  });
  console.log('✅ payouts');

  await db.schema.createTableIfNotExists('audit_log', t => {
    t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
    t.timestamp('run_at').notNullable().defaultTo(db.fn.now());
    t.string('status').notNullable();
    t.integer('total_entries').notNullable().defaultTo(0);
    t.decimal('total_volume', 18, 8).notNullable().defaultTo(0);
    t.decimal('total_fees', 18, 8).notNullable().defaultTo(0);
    t.string('chain_hash').notNullable();
    t.integer('anomalies').notNullable().defaultTo(0);
    t.jsonb('anomaly_details').nullable();
    t.timestamp('created_at').notNullable().defaultTo(db.fn.now());
  });
  console.log('✅ audit_log');

  console.log('✅ All tables ready');
  await db.destroy();
  process.exit(0);
}

migrate().catch(e => {
  console.error('Migration failed:', e.message);
  process.exit(1);
});