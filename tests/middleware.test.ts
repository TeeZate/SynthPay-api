import { describe, it, expect, beforeAll } from 'vitest'
import { db } from '../src/db/index'
import { atomicDeduct } from '../src/server/ledger'

describe('TrustLedger Core', () => {

  let user_id:     string
  let merchant_id: string
  let endpoint_id: string

  beforeAll(async () => {
    // Create test user with balance
    const [user] = await db('users')
      .insert({ balance: 1.00, reputation: 'new' })
      .returning('id')
    user_id = user.id

    // Create test merchant
    const [merchant] = await db('merchants')
      .insert({ 
        name:    'Test Merchant',
        api_key: 'test_key_123',
        balance: 0,
        total_earned: 0,
        active:  true
      })
      .returning('id')
    merchant_id = merchant.id

    // Create test endpoint
    const [endpoint] = await db('endpoints')
      .insert({
        merchant_id,
        path:   '/test',
        price:  0.001,
        active: true
      })
      .returning('id')
    endpoint_id = endpoint.id
  })

  it('deducts correct amount from user', async () => {
    const result = await atomicDeduct({
      user_id,
      merchant_id,
      endpoint_id,
      amount: 0.001
    })
    expect(result.success).toBe(true)
    expect(result.balance_after).toBe(0.999)
  })

  it('credits merchant correctly', async () => {
    const merchant = await db('merchants')
      .where({ id: merchant_id })
      .first()
    const expected = 0.001 * 0.985
    expect(Number(merchant.balance)).toBeCloseTo(expected, 6)
  })

  it('records transaction in ledger', async () => {
    const entry = await db('ledger')
      .where({ user_id, merchant_id })
      .first()
    expect(entry).toBeTruthy()
    expect(Number(entry.amount)).toBe(0.001)
  })

  it('blocks payment when balance is zero', async () => {
    const result = await atomicDeduct({
      user_id,
      merchant_id,
      endpoint_id,
      amount: 999
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain('Insufficient')
  })

  it('handles concurrent payments safely', async () => {
    // Fire 10 simultaneous payments
    // Only as many as balance allows should succeed
    const [user] = await db('users')
      .insert({ balance: 0.003, reputation: 'new' })
      .returning('id')

    const payments = Array(10).fill(null).map(() =>
      atomicDeduct({
        user_id:     user.id,
        merchant_id,
        endpoint_id,
        amount: 0.001
      })
    )

    const results = await Promise.all(payments)
    const succeeded = results.filter(r => r.success).length
    const failed    = results.filter(r => !r.success).length

    // Only 3 should succeed — balance was $0.003
    expect(succeeded).toBe(3)
    expect(failed).toBe(7)

    // Final balance must be exactly 0
    const finalUser = await db('users')
      .where({ id: user.id })
      .first()
    expect(Number(finalUser.balance)).toBe(0)
  })
})