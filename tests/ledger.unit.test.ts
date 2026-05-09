/**
 * Unit tests for atomicDeduct — all DB calls are mocked.
 * Run with: npx vitest run tests/ledger.unit.test.ts
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'

// ── Mock the DB module before importing the module under test ─────────────────
const mockTrx = {
  where:      vi.fn().mockReturnThis(),
  whereNot:   vi.fn().mockReturnThis(),
  decrement:  vi.fn().mockReturnThis(),
  increment:  vi.fn().mockReturnThis(),
  insert:     vi.fn().mockResolvedValue(undefined),
  returning:  vi.fn(),
}

const mockDb = vi.fn().mockReturnValue(mockTrx) as Mock & {
  transaction: Mock
}
mockDb.transaction = vi.fn()

vi.mock('../src/db/index', () => ({ db: mockDb }))

// Import AFTER mock is set up
const { atomicDeduct } = await import('../src/server/ledger')

// ── Helpers ───────────────────────────────────────────────────────────────────
const BASE_PARAMS = {
  user_id:     'user-111',
  merchant_id: 'merch-222',
  endpoint_id: 'ep-333',
  amount:      1.0,
}

function setupSuccessfulTransaction(balanceAfter: number) {
  mockDb.transaction.mockImplementation(async (cb: Function) => {
    mockTrx.returning.mockResolvedValue([{ balance: balanceAfter }])
    return cb(mockTrx)
  })
}

function setupInsufficientFunds() {
  mockDb.transaction.mockImplementation(async (cb: Function) => {
    mockTrx.returning.mockResolvedValue([])   // nothing updated = insufficient
    return cb(mockTrx)
  })
}

// ── Tests ─────────────────────────────────────────────────────────────────────
describe('atomicDeduct — unit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDb.mockReturnValue(mockTrx)
  })

  it('returns success + correct balance_after on a valid deduction', async () => {
    setupSuccessfulTransaction(9.0)

    const result = await atomicDeduct({ ...BASE_PARAMS, amount: 1.0 })

    expect(result.success).toBe(true)
    expect(result.balance_after).toBe(9.0)
  })

  it('returns success: false with INSUFFICIENT_FUNDS when balance too low', async () => {
    setupInsufficientFunds()

    const result = await atomicDeduct({ ...BASE_PARAMS, amount: 999.0 })

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/insufficient/i)
  })

  it('calculates platform fee as 1.5% of amount', async () => {
    setupSuccessfulTransaction(8.5)
    await atomicDeduct({ ...BASE_PARAMS, amount: 2.0 })

    // merchant increment should be called with (amount - 1.5%)
    const expectedFee      = Number((2.0 * 0.015).toFixed(8))
    const expectedMerchant = Number((2.0 - expectedFee).toFixed(8))

    // The trx('merchants').increment call receives merchant_receives
    const incrementCalls = mockTrx.increment.mock.calls
    expect(incrementCalls.some(
      ([col, val]: [string, number]) => col === 'balance' && Math.abs(val - expectedMerchant) < 0.000001
    )).toBe(true)
  })

  it('writes a ledger row on success', async () => {
    setupSuccessfulTransaction(5.0)
    await atomicDeduct(BASE_PARAMS)

    expect(mockTrx.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id:     BASE_PARAMS.user_id,
        merchant_id: BASE_PARAMS.merchant_id,
        endpoint_id: BASE_PARAMS.endpoint_id,
        amount:      BASE_PARAMS.amount,
        status:      'completed',
      })
    )
  })

  it('does NOT write a ledger row when balance is insufficient', async () => {
    setupInsufficientFunds()
    await atomicDeduct(BASE_PARAMS)

    // insert is only called after the balance check succeeds
    expect(mockTrx.insert).not.toHaveBeenCalled()
  })

  it('returns success: false (generic error) on unexpected DB exception', async () => {
    mockDb.transaction.mockRejectedValue(new Error('DB connection lost'))

    const result = await atomicDeduct(BASE_PARAMS)

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/transaction failed/i)
  })

  it('handles fractional micro-payments without floating-point blowup', async () => {
    setupSuccessfulTransaction(0.9999)
    const result = await atomicDeduct({ ...BASE_PARAMS, amount: 0.0001 })

    expect(result.success).toBe(true)
    // platform fee = 0.0001 * 0.015 — must not produce NaN or Infinity
    expect(Number.isFinite(result.balance_after!)).toBe(true)
  })
})
