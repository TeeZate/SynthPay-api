/**
 * Integration tests for atomicDeduct — require a real PostgreSQL connection.
 * Set DATABASE_URL before running:
 *   DATABASE_URL=postgresql://... npx vitest run tests/ledger.integration.test.ts
 *
 * Tests are skipped automatically when DATABASE_URL is absent.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import knex, { type Knex } from 'knex'

const DATABASE_URL = process.env.DATABASE_URL
const skip         = !DATABASE_URL

let db: Knex

// ── Schema helpers ────────────────────────────────────────────────────────────
async function seed(db: Knex) {
  await db('ledger').delete()
  await db('passkeys').delete()
  await db('topups').delete()
  await db('users').delete()
  await db('merchants').delete()
  await db('endpoints').delete()

  const [user] = await db('users')
    .insert({ balance: 100.0, reputation: 'new' })
    .returning(['id', 'balance'])

  const [merchant] = await db('merchants')
    .insert({ name: 'Test Merchant', api_key: `test_${Date.now()}`, balance: 0, total_earned: 0, active: true })
    .returning(['id'])

  const [endpoint] = await db('endpoints')
    .insert({ merchant_id: merchant.id, path: '/test', price: 1.0, active: true })
    .returning(['id'])

  return { userId: user.id, merchantId: merchant.id, endpointId: endpoint.id }
}

// ── Suite ─────────────────────────────────────────────────────────────────────
describe.skipIf(skip)('atomicDeduct — integration (requires DATABASE_URL)', () => {
  let ids: { userId: string; merchantId: string; endpointId: string }

  beforeAll(async () => {
    db = knex({ client: 'pg', connection: DATABASE_URL })
    // Use the real db module with the live connection
    process.env.DATABASE_URL = DATABASE_URL
  })

  afterAll(async () => {
    await db.destroy()
  })

  beforeEach(async () => {
    ids = await seed(db)
  })

  it('deducts from user balance and credits merchant atomically', async () => {
    const { atomicDeduct } = await import('../src/server/ledger')

    const result = await atomicDeduct({
      user_id:     ids.userId,
      merchant_id: ids.merchantId,
      endpoint_id: ids.endpointId,
      amount:      1.0,
    })

    expect(result.success).toBe(true)
    expect(result.balance_after).toBeCloseTo(99.0, 4)

    const user     = await db('users').where({ id: ids.userId }).first()
    const merchant = await db('merchants').where({ id: ids.merchantId }).first()
    const ledger   = await db('ledger').where({ user_id: ids.userId }).first()

    expect(Number(user.balance)).toBeCloseTo(99.0, 4)
    expect(Number(merchant.balance)).toBeCloseTo(1.0 * (1 - 0.015), 4)
    expect(ledger).toBeTruthy()
    expect(ledger.status).toBe('completed')
  })

  it('rejects payment when balance is insufficient', async () => {
    const { atomicDeduct } = await import('../src/server/ledger')

    const result = await atomicDeduct({
      user_id:     ids.userId,
      merchant_id: ids.merchantId,
      endpoint_id: ids.endpointId,
      amount:      999.0,
    })

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/insufficient/i)

    const user    = await db('users').where({ id: ids.userId }).first()
    const ledgers = await db('ledger').where({ user_id: ids.userId })

    // Balance unchanged, no ledger row written
    expect(Number(user.balance)).toBe(100.0)
    expect(ledgers.length).toBe(0)
  })

  it('handles 10 concurrent deductions correctly — no double-spend', async () => {
    const { atomicDeduct } = await import('../src/server/ledger')

    // User has $100, 10 concurrent $5 deductions = exactly $50 expected
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        atomicDeduct({
          user_id:     ids.userId,
          merchant_id: ids.merchantId,
          endpoint_id: ids.endpointId,
          amount:      5.0,
        })
      )
    )

    const successful = results.filter(r => r.success)
    const failed     = results.filter(r => !r.success)

    // All 10 should succeed ($100 / $5 = 20 possible, so all go through)
    expect(successful.length).toBe(10)
    expect(failed.length).toBe(0)

    const user = await db('users').where({ id: ids.userId }).first()
    expect(Number(user.balance)).toBeCloseTo(50.0, 4)

    const rows = await db('ledger').where({ user_id: ids.userId })
    expect(rows.length).toBe(10)
  })

  it('prevents overdraft under concurrent load', async () => {
    const { atomicDeduct } = await import('../src/server/ledger')

    // User has $100, 30 concurrent $9 deductions — only 11 can succeed
    const results = await Promise.all(
      Array.from({ length: 30 }, () =>
        atomicDeduct({
          user_id:     ids.userId,
          merchant_id: ids.merchantId,
          endpoint_id: ids.endpointId,
          amount:      9.0,
        })
      )
    )

    const successful = results.filter(r => r.success)

    // At most floor(100/9) = 11 deductions can succeed
    expect(successful.length).toBeLessThanOrEqual(11)

    const user = await db('users').where({ id: ids.userId }).first()
    // Balance must never go negative
    expect(Number(user.balance)).toBeGreaterThanOrEqual(0)
  })
})
