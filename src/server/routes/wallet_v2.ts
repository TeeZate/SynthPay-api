import { FastifyInstance } from 'fastify'
import { db } from '../../db/index'
import Stripe from 'stripe'
import dotenv from 'dotenv'
import { resolve } from 'path'

dotenv.config({ path: resolve(process.cwd(), '.env') })

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2026-03-25.dahlia'
})

export const walletRoutes = async (server: FastifyInstance) => {

  // ── CREATE PAYMENT INTENT — returns client_secret for Stripe Payment Element
  server.post('/wallet/topup/intent', async (request, reply) => {
    const { user_id, amount } = request.body as { user_id: string; amount: number }

    if (!user_id || !amount || Number(amount) < 1 || Number(amount) > 1000) {
      return reply.status(400).send({ error: 'user_id required and amount must be 1–1000' })
    }

    const user = await db('users').where({ id: user_id }).first()
    if (!user) return reply.status(404).send({ error: 'User not found' })

    const amountCents = Math.round(Number(amount) * 100)

    const paymentIntent = await stripe.paymentIntents.create({
      amount:   amountCents,
      currency: 'usd',
      metadata: { user_id, type: 'wallet_topup', amount_usd: String(amount) },
      automatic_payment_methods: { enabled: true },
    })

    // Record pending topup — webhook marks it completed on payment_intent.succeeded
    await db('topups').insert({
      user_id,
      amount:            Number(amount),
      stripe_payment_id: paymentIntent.id,
      status:            'pending',
      idempotency_key:   paymentIntent.id,
    })

    return reply.send({
      client_secret:     paymentIntent.client_secret,
      publishable_key:   process.env.STRIPE_PUBLISHABLE_KEY,
      payment_intent_id: paymentIntent.id,
    })
  })

  // ── CREATE TOP-UP — with idempotency key ─────────────────────────────────
  server.post('/wallet/topup/create', async (request, reply) => {
    const { user_id, amount, idempotency_key } = request.body as {
      user_id:          string
      amount:           number
      idempotency_key?: string
    }

    if (!user_id || !amount) {
      return reply.status(400).send({ error: 'user_id and amount required' })
    }

    if (amount < 1) {
      return reply.status(400).send({ error: 'Minimum top-up amount is $1' })
    }

    if (amount > 1000) {
      return reply.status(400).send({ error: 'Maximum top-up amount is $1,000' })
    }

    const user = await db('users').where({ id: user_id }).first()
    if (!user) {
      return reply.status(404).send({ error: 'User not found' })
    }

    // ── Idempotency check ──────────────────────────────────────────────────
    // If a key was provided, check if this request was already processed
    if (idempotency_key) {
      const existing = await db('topups')
        .where({ idempotency_key })
        .first()

      if (existing) {
        // Already processed — return the original result without charging again
        console.log(`Duplicate top-up request blocked: ${idempotency_key}`)
        const currentUser = await db('users').where({ id: user_id }).first()
        return reply.send({
          success:        true,
          user_id,
          amount_added:   Number(existing.amount),
          new_balance:    Number(currentUser?.balance || 0),
          message:        'Account credited successfully',
          idempotent:     true  // signals this was a duplicate, not a new charge
        })
      }
    }

    // ── Generate key if not provided ──────────────────────────────────────
    const key = idempotency_key || `auto_${user_id}_${Date.now()}`

    // ── Atomic credit + record ────────────────────────────────────────────
    const newBalance = Number(user.balance) + Number(amount)

    try {
      await db.transaction(async trx => {
        await trx('users')
          .where({ id: user_id })
          .update({ balance: newBalance })

        await trx('topups').insert({
          user_id,
          amount:            Number(amount),
          stripe_payment_id: `demo_${Date.now()}`,
          status:            'completed',
          idempotency_key:   key
        })
      })
    } catch (err: any) {
      // Unique constraint violation = duplicate request raced through
      if (err.code === '23505') {
        console.log(`Race condition caught by DB constraint: ${key}`)
        const currentUser = await db('users').where({ id: user_id }).first()
        return reply.send({
          success:      true,
          user_id,
          amount_added: Number(amount),
          new_balance:  Number(currentUser?.balance || 0),
          message:      'Wallet credited successfully',
          idempotent:   true
        })
      }
      throw err
    }

    return reply.send({
      success:      true,
      user_id,
      amount_added: Number(amount),
      new_balance:  newBalance,
      message:      'Wallet credited successfully'
    })
  })

  // ── STRIPE WEBHOOK ────────────────────────────────────────────────────────
  server.post('/wallet/topup/webhook', {
    config: { rawBody: true }
  }, async (request, reply) => {
    const sig = request.headers['stripe-signature'] as string

    if (!sig) {
      return reply.status(400).send({ error: 'Missing stripe-signature header' })
    }

    let event: Stripe.Event | any

    try {
      event = stripe.webhooks.constructEvent(
        (request as any).rawBody || JSON.stringify(request.body),
        sig,
        process.env.STRIPE_WEBHOOK_SECRET!
      )
    } catch (err: any) {
      console.error('Webhook signature verification failed:', err.message)
      return reply.status(400).send({ error: `Webhook error: ${err.message}` })
    }

    if (event.type === 'payment_intent.succeeded') {
      const paymentIntent = event.data.object as unknown as Stripe.PaymentIntent
      const { user_id, type } = paymentIntent.metadata

      if (type !== 'wallet_topup' || !user_id) {
        return reply.send({ received: true })
      }

      const topup = await db('topups')
        .where({ stripe_payment_id: paymentIntent.id })
        .first()

      if (!topup) {
        console.error('Topup record not found for:', paymentIntent.id)
        return reply.send({ received: true })
      }

      if (topup.status === 'completed') {
        console.log('Duplicate webhook ignored:', paymentIntent.id)
        return reply.send({ received: true })
      }

      const amount = paymentIntent.amount / 100

      await db.transaction(async (trx) => {
        await trx('users')
          .where({ id: user_id })
          .increment('balance', amount)

        await trx('topups')
          .where({ stripe_payment_id: paymentIntent.id })
          .update({ status: 'completed' })
      })

      console.log(`Wallet credited: user ${user_id} +$${amount}`)
    }

    if (event.type === 'payment_intent.payment_failed') {
      const paymentIntent = event.data.object as unknown as Stripe.PaymentIntent

      await db('topups')
        .where({ stripe_payment_id: paymentIntent.id })
        .update({ status: 'failed' })
    }

    return reply.send({ received: true })
  })

  // ── GET TOPUP HISTORY ─────────────────────────────────────────────────────
  server.get('/wallet/topups/:user_id', async (request, reply) => {
    const { user_id } = request.params as { user_id: string }

    const topups = await db('topups')
      .where({ user_id })
      .orderBy('created_at', 'desc')
      .select('id', 'amount', 'status', 'created_at', 'stripe_payment_id')

    const totalDeposited = topups
      .filter(t => t.status === 'completed')
      .reduce((sum, t) => sum + Number(t.amount), 0)

    return reply.send({
      user_id,
      total_deposited: totalDeposited,
      topups
    })
  })
}
