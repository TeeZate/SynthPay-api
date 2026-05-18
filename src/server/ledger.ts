import { db } from '../db/index'
import { createHash, randomUUID } from 'crypto'

interface DeductParams {
  user_id:     string
  merchant_id: string
  endpoint_id: string
  amount:      number
}

interface DeductResult {
  success:       boolean
  balance_after?: number
  error?:        string
}

export const atomicDeduct = async (
  params: DeductParams
): Promise<DeductResult> => {

  const { user_id, merchant_id, endpoint_id, amount } = params
  const platform_fee     = Number((amount * 0.015).toFixed(8))
  const merchant_receives = Number((amount - platform_fee).toFixed(8))

  try {
    const result = await db.transaction(async (trx) => {

      // STEP 1 — Deduct from user balance atomically
      // This single query does the check AND the deduct
      // No race condition possible
      const updated = await trx('users')
        .where({ id: user_id })
        .where('balance', '>=', amount)
        .decrement('balance', amount)
        .returning(['balance'])

      // If nothing updated — insufficient funds
      if (updated.length === 0) {
        throw new Error('INSUFFICIENT_FUNDS')
      }

      const balance_after = Number(updated[0].balance)

      // STEP 2 — Credit merchant instantly
      await trx('merchants')
        .where({ id: merchant_id })
        .increment('balance', merchant_receives)
        .increment('total_earned', merchant_receives)

      // STEP 3 — Write to immutable ledger with hash chain
      // Generate id + timestamp in app so we can compute the hash BEFORE inserting.
      // This means only 1 extra query (the prev_hash SELECT) instead of 3,
      // keeping settlement latency as close to original as possible.
      const newId     = randomUUID()
      const createdAt = new Date()

      // Lock the tail of the chain to get prev_hash and prevent concurrent hash writes
      const lastEntry = await trx('ledger')
        .orderBy('created_at', 'desc')
        .select('entry_hash')
        .first()
        .forUpdate()

      const prevHash = lastEntry?.entry_hash || '0000000000000000'

      // Compute hash before insert — SHA256(id|user_id|merchant_id|amount|fee|timestamp|prev_hash)
      const entryData = `${newId}|${user_id}|${merchant_id}|${Number(amount)}|${Number(platform_fee)}|${createdAt}|${prevHash}`
      const entryHash = createHash('sha256').update(entryData).digest('hex')

      // Single INSERT — hash is already computed, no RETURNING or UPDATE needed
      await trx('ledger').insert({
        id:                 newId,
        user_id,
        merchant_id,
        endpoint_id,
        amount,
        platform_fee,
        merchant_receives,
        user_balance_after: balance_after,
        created_at:         createdAt,
        status:             'completed',
        entry_hash:         entryHash,
        prev_hash:          prevHash
      })

      return balance_after
    })

    return { 
      success: true, 
      balance_after: result 
    }

  } catch (err: any) {
    if (err.message === 'INSUFFICIENT_FUNDS') {
      return { 
        success: false, 
        error: 'Insufficient balance. Please top up your account.'
      }
    }
    // Log unexpected errors but never expose internals
    console.error('Ledger error:', err)
    return { 
      success: false, 
      error: 'Transaction failed. Please try again.' 
    }
  }
}

// Get user balance
export const getBalance = async (user_id: string): Promise<number> => {
  const user = await db('users')
    .where({ id: user_id })
    .select('balance')
    .first()
  return user ? Number(user.balance) : 0
}

// Get merchant earnings
export const getMerchantEarnings = async (merchant_id: string) => {
  const merchant = await db('merchants')
    .where({ id: merchant_id })
    .select('balance', 'total_earned')
    .first()
  return merchant || { balance: 0, total_earned: 0 }
}

// Get transaction history for a user
export const getUserLedger = async (user_id: string, limit = 50) => {
  return await db('ledger')
    .where({ user_id })
    .orderBy('created_at', 'desc')
    .limit(limit)
}