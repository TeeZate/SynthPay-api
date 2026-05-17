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

  // ── CREATE PAYMENT INTENT — returns client_secret for Stripe Elements ────
  server.post('/wallet/topup/intent', async (request, reply) => {
    const { user_id, amount } = request.body as { user_id: string; amount: number }

    if (!user_id || !amount) {
      return reply.status(400).send({ error: 'user_id and amount required' })
    }
    if (amount < 1)    return reply.status(400).send({ error: 'Minimum top-up is $1' })
    if (amount > 1000) return reply.status(400).send({ error: 'Maximum top-up is $1,000' })

    const user = await db('users').where({ id: user_id }).first()
    if (!user) return reply.status(404).send({ error: 'User not found' })

    // Create Stripe PaymentIntent
    const paymentIntent = await stripe.paymentIntents.create({
      amount:   Math.round(amount * 100), // cents
      currency: 'usd',
      metadata: { user_id, type: 'wallet_topup' },
      automatic_payment_methods: { enabled: true },
    })

    // Pre-create topup record as pending so the webhook can find it
    await db('topups').insert({
      user_id,
      amount:            Number(amount),
      stripe_payment_id: paymentIntent.id,
      status:            'pending',
    })

    return reply.send({
      client_secret:   paymentIntent.client_secret,
      publishable_key: process.env.STRIPE_PUBLISHABLE_KEY,
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
        // Fallback: insert the record and credit — should not happen normally
        const amount = paymentIntent.amount / 100
        await db.transaction(async (trx) => {
          await trx('users').where({ id: user_id }).increment('balance', amount)
          await trx('topups').insert({
            user_id,
            amount,
            stripe_payment_id: paymentIntent.id,
            status: 'completed',
          })
        })
        console.log(`Wallet credited (fallback): user ${user_id} +$${amount}`)
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

  // ── ZIINA (UAE) — stub until API keys are live ────────────────────────────
  server.post('/wallet/topup/ziina', async (request, reply) => {
    const { user_id, amount_usd } = request.body as { user_id: string; amount_usd: number }

    if (!user_id || !amount_usd) {
      return reply.status(400).send({ error: 'user_id and amount_usd required' })
    }
    if (amount_usd < 1)    return reply.status(400).send({ error: 'Minimum top-up is $1' })
    if (amount_usd > 1000) return reply.status(400).send({ error: 'Maximum top-up is $1,000' })

    const user = await db('users').where({ id: user_id }).first()
    if (!user) return reply.status(404).send({ error: 'User not found' })

    const AED_RATE = Number(process.env.ZIINA_USD_TO_AED || 3.67)
    const amount_aed = Number((amount_usd * AED_RATE).toFixed(2))
    const ref = `ziina_stub_${Date.now()}_${user_id.slice(0, 8)}`

    // Pre-create pending topup record
    await db('topups').insert({
      user_id,
      amount:            amount_usd,
      stripe_payment_id: ref,           // reuse column (unique ref)
      status:            'pending',
      provider:          'ziina',
      currency:          'AED',
      payment_ref:       ref,
    })

    // ── STUB: replace with real Ziina API call when key is available ──────
    // const ziina = await fetch('https://api.ziina.com/v1/payment-requests', {
    //   method: 'POST',
    //   headers: { Authorization: `Bearer ${process.env.ZIINA_API_KEY}`, 'Content-Type': 'application/json' },
    //   body: JSON.stringify({ amount: amount_aed, currency: 'AED', reference: ref,
    //                          redirect_url: `${process.env.APP_URL}/topup/success?ref=${ref}` })
    // }).then(r => r.json())
    // return reply.send({ payment_url: ziina.payment_url, ref, amount_aed })

    return reply.send({
      payment_url: `https://pay.ziina.com/stub/${ref}`,   // placeholder
      ref,
      amount_aed,
      amount_usd,
      stub: true,
    })
  })

  // Ziina webhook (fires when user pays in Ziina app)
  server.post('/wallet/topup/ziina/webhook', async (request, reply) => {
    // ── STUB: real implementation validates Ziina webhook signature ────────
    // const sig = request.headers['x-ziina-signature']
    // verify sig with ZIINA_WEBHOOK_SECRET ...

    const { reference, status } = request.body as { reference: string; status: string }

    if (status !== 'PAID') return reply.send({ received: true })

    const topup = await db('topups').where({ payment_ref: reference, provider: 'ziina' }).first()
    if (!topup || topup.status === 'completed') return reply.send({ received: true })

    await db.transaction(async (trx) => {
      await trx('users').where({ id: topup.user_id }).increment('balance', topup.amount)
      await trx('topups').where({ id: topup.id }).update({ status: 'completed' })
    })

    console.log(`[Ziina] Wallet credited: user ${topup.user_id} +$${topup.amount}`)
    return reply.send({ received: true })
  })

  // ── NARDO PAY (Africa) — stub until API keys are live ────────────────────
  server.post('/wallet/topup/nardo', async (request, reply) => {
    const { user_id, amount_usd, phone, currency } = request.body as {
      user_id:    string
      amount_usd: number
      phone:      string
      currency:   string
    }

    if (!user_id || !amount_usd || !phone || !currency) {
      return reply.status(400).send({ error: 'user_id, amount_usd, phone and currency required' })
    }
    if (amount_usd < 1)    return reply.status(400).send({ error: 'Minimum top-up is $1' })
    if (amount_usd > 1000) return reply.status(400).send({ error: 'Maximum top-up is $1,000' })

    const user = await db('users').where({ id: user_id }).first()
    if (!user) return reply.status(404).send({ error: 'User not found' })

    const ref = `nardo_stub_${Date.now()}_${user_id.slice(0, 8)}`

    // FX rates — replace with live Nardo Pay API rates when available
    const FX: Record<string, number> = {
      KES: 129.5, NGN: 1580, GHS: 15.2, ZAR: 18.4,
      UGX: 3720, TZS: 2590, ZMW: 25.8, XOF: 605,
    }
    const rate       = FX[currency] || 1
    const local_amount = Number((amount_usd * rate).toFixed(2))

    await db('topups').insert({
      user_id,
      amount:            amount_usd,
      stripe_payment_id: ref,
      status:            'pending',
      provider:          'nardo',
      currency,
      payment_ref:       ref,
    })

    // ── STUB: replace with real Nardo Pay API call when key is available ──
    // const nardo = await fetch('https://api.nardopay.com/v1/charges', {
    //   method: 'POST',
    //   headers: { Authorization: `Bearer ${process.env.NARDO_API_KEY}` },
    //   body: JSON.stringify({ phone, currency, amount: local_amount, reference: ref })
    // }).then(r => r.json())

    return reply.send({
      ref,
      amount_usd,
      local_amount,
      currency,
      phone,
      instructions: `A payment prompt of ${currency} ${local_amount.toLocaleString()} has been sent to ${phone}. Approve it on your phone to credit your account.`,
      stub: true,
    })
  })

  // Nardo Pay webhook
  server.post('/wallet/topup/nardo/webhook', async (request, reply) => {
    // ── STUB: real implementation validates Nardo webhook signature ─────────
    const { reference, status } = request.body as { reference: string; status: string }

    if (status !== 'SUCCESS') return reply.send({ received: true })

    const topup = await db('topups').where({ payment_ref: reference, provider: 'nardo' }).first()
    if (!topup || topup.status === 'completed') return reply.send({ received: true })

    await db.transaction(async (trx) => {
      await trx('users').where({ id: topup.user_id }).increment('balance', topup.amount)
      await trx('topups').where({ id: topup.id }).update({ status: 'completed' })
    })

    console.log(`[Nardo] Wallet credited: user ${topup.user_id} +$${topup.amount}`)
    return reply.send({ received: true })
  })

  // ── GET TOPUP STATUS (for polling — Ziina / Nardo) ────────────────────────
  server.get('/wallet/topup/status/:ref', async (request, reply) => {
    const { ref } = request.params as { ref: string }

    const topup = await db('topups').where({ payment_ref: ref }).first()
    if (!topup) return reply.status(404).send({ error: 'Topup not found' })

    return reply.send({
      ref,
      status:   topup.status,
      provider: topup.provider,
      amount:   Number(topup.amount),
      currency: topup.currency,
    })
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
