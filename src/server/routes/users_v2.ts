import { FastifyInstance } from 'fastify'
import { db } from '../../db/index'
import { atomicDeduct, getBalance, getUserLedger } from '../ledger'
import { randomBytes } from 'crypto'

// ── Velocity limits ──────────────────────────────────────────────────────────
const MAX_SPEND_PER_DAY   = 500    // $500 daily limit
const DUPLICATE_WINDOW_MS = 5000   // 5 seconds — catches retries

export const userRoutes = async (server: FastifyInstance) => {

  // ── Create user ──────────────────────────────────────────────────────────
  server.post('/users/create', async (request, reply) => {
    const [user] = await db('users')
      .insert({ display_name: null, balance: 0, reputation: 'new' })
      .returning(['id', 'balance', 'reputation', 'created_at'])

    return reply.status(201).send({
      message: 'Wallet created',
      user_id: user.id,
      balance: Number(user.balance)
    })
  })

  // ── Get balance ──────────────────────────────────────────────────────────
  server.get('/users/:user_id/balance', async (request, reply) => {
    const { user_id } = request.params as { user_id: string }

    const user = await db('users')
      .where({ id: user_id })
      .select('id', 'balance', 'reputation')
      .first()

    if (!user) return reply.status(404).send({ error: 'User not found' })

    return reply.send({
      user_id:    user.id,
      balance:    Number(user.balance),
      reputation: user.reputation
    })
  })

  // ── Manual topup (test only) ─────────────────────────────────────────────
  server.post('/users/:user_id/topup', async (request, reply) => {
    const { user_id } = request.params as { user_id: string }
    const { amount }  = request.body as { amount: number }

    if (!amount || amount <= 0 || amount > 1000) {
      return reply.status(400).send({ error: 'Amount must be between 0 and 1000' })
    }

    const user = await db('users').where({ id: user_id }).first()
    if (!user) return reply.status(404).send({ error: 'User not found' })

    const stripe_payment_id = `test_${randomBytes(16).toString('hex')}`

    await db('topups').insert({ user_id, amount, stripe_payment_id, status: 'completed' })

    const [updated] = await db('users')
      .where({ id: user_id })
      .increment('balance', amount)
      .returning(['balance'])

    return reply.send({
      message:      'Balance topped up',
      user_id,
      amount_added: amount,
      new_balance:  Number(updated.balance)
    })
  })

  // ── MAKE A PAYMENT — core action with fraud protection ───────────────────
  server.post('/users/pay', async (request, reply) => {
    const { user_id, merchant_id, endpoint_id, amount } = request.body as {
      user_id:     string
      merchant_id: string
      endpoint_id: string
      amount:      number
    }

    if (!user_id || !merchant_id || !endpoint_id || !amount) {
      return reply.status(400).send({
        error: 'user_id, merchant_id, endpoint_id and amount required'
      })
    }

    // ── 1. Verify endpoint exists and price matches ────────────────────────
    const endpoint = await db('endpoints')
      .where({ id: endpoint_id, merchant_id, active: true })
      .first()

    if (!endpoint) {
      return reply.status(404).send({ error: 'Endpoint not found' })
    }

    if (Math.abs(Number(endpoint.price) - Number(amount)) > 0.000001) {
      return reply.status(400).send({ error: 'Amount does not match endpoint price' })
    }

    // ── 2. Duplicate detection — 5 second window ──────────────────────────
    // Catches frontend retries, network glitches, double-taps
    const duplicateWindow = new Date(Date.now() - DUPLICATE_WINDOW_MS)
    const recentDuplicate = await db('ledger')
      .where({ user_id, endpoint_id })
      .where('created_at', '>', duplicateWindow)
      .first()

    if (recentDuplicate) {
      console.log(`Duplicate payment blocked: user ${user_id} endpoint ${endpoint_id}`)
      // Return success with cached balance — user sees no error, no double charge
      const user = await db('users').where({ id: user_id }).first()
      return reply.send({
        success:       true,
        balance_after: Number(user?.balance || 0),
        duplicate:     true
      })
    }

    // ── 3. Velocity check — daily spend limit ─────────────────────────────
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    const todaySpend = await db('ledger')
      .where({ user_id })
      .where('created_at', '>=', today)
      .sum('amount as total')
      .first()

    const spentToday = Number(todaySpend?.total || 0)

    if (spentToday + Number(amount) > MAX_SPEND_PER_DAY) {
      return reply.status(429).send({
        error: `Daily spend limit of $${MAX_SPEND_PER_DAY} reached. Resets at midnight.`,
        spent_today: spentToday,
        limit:       MAX_SPEND_PER_DAY
      })
    }

    // ── 4. Atomic deduction ────────────────────────────────────────────────
    const result = await atomicDeduct({
      user_id,
      merchant_id,
      endpoint_id,
      amount: Number(amount)
    })

    if (!result.success) {
      return reply.status(402).send({
        error:     result.error,
        topup_url: '/wallet/topup'
      })
    }

    return reply.send({
      success:       true,
      balance_after: result.balance_after
    })
  })

  // ── Get transaction history ───────────────────────────────────────────────
  server.get('/users/:user_id/history', async (request, reply) => {
    const { user_id } = request.params as { user_id: string }

    const user = await db('users').where({ id: user_id }).first()
    if (!user) return reply.status(404).send({ error: 'User not found' })

    // Join with merchants to get merchant name
    const history = await db('ledger as l')
      .leftJoin('merchants as m', 'l.merchant_id', 'm.id')
      .where('l.user_id', user_id)
      .orderBy('l.created_at', 'desc')
      .limit(100)
      .select(
        'l.id',
        'l.amount',
        'l.platform_fee',
        'l.merchant_receives',
        'l.user_balance_after',
        'l.created_at',
        'm.name as merchant_name'
      )

    return reply.send({
      user_id,
      balance:      Number(user.balance),
      transactions: history
    })
  })
}
