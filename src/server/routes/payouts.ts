import { FastifyInstance } from 'fastify'
import { db } from '../../db/index'
import Stripe from 'stripe'
import dotenv from 'dotenv'
import { resolve } from 'path'

dotenv.config({ path: resolve(process.cwd(), '.env') })

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2026-03-25.dahlia'
})

const MIN_WITHDRAWAL = 10  // USD

// ── Helper: validate merchant from api_key header ─────────────────────────────
const getMerchant = async (api_key: string) => {
  return db('merchants').where({ api_key, active: true }).first()
}

export const payoutRoutes = async (server: FastifyInstance) => {

  // ── GET BALANCE SNAPSHOT ──────────────────────────────────────────────────
  server.get('/merchants/balance', async (request, reply) => {
    const api_key = request.headers['x-api-key'] as string
    if (!api_key) return reply.status(401).send({ error: 'API key required' })

    const merchant = await getMerchant(api_key)
    if (!merchant) return reply.status(401).send({ error: 'Invalid API key' })

    // Sum any pending payouts (balance already deducted, but useful for UI)
    const pendingRow = await db('payouts')
      .where({ merchant_id: merchant.id, status: 'pending' })
      .sum('amount as total')
      .first()

    return reply.send({
      merchant_id:     merchant.id,
      available:       Number(merchant.balance),
      total_earned:    Number(merchant.total_earned),
      pending_payouts: Number(pendingRow?.total || 0),
      has_stripe:      !!merchant.stripe_account_id,
    })
  })

  // ── BANK TRANSFER WITHDRAWAL ──────────────────────────────────────────────
  // Merchant provides bank details → creates pending record → admin wires manually
  server.post('/merchants/payout/bank-transfer', async (request, reply) => {
    const {
      api_key, amount,
      bank_name, account_name, account_number,
      swift_code, iban, routing_number, country,
    } = request.body as {
      api_key:          string
      amount?:          number
      bank_name:        string
      account_name:     string
      account_number:   string
      swift_code?:      string
      iban?:            string
      routing_number?:  string
      country:          string
    }

    if (!api_key) return reply.status(401).send({ error: 'API key required' })

    if (!bank_name || !account_name || !account_number || !country) {
      return reply.status(400).send({
        error: 'bank_name, account_name, account_number and country are all required'
      })
    }

    const merchant = await getMerchant(api_key)
    if (!merchant) return reply.status(401).send({ error: 'Invalid API key' })

    const balance        = Number(merchant.balance)
    const withdrawAmount = amount ? Number(amount) : balance

    if (withdrawAmount < MIN_WITHDRAWAL) {
      return reply.status(400).send({
        error:           `Minimum withdrawal is $${MIN_WITHDRAWAL}`,
        current_balance: balance,
      })
    }

    if (withdrawAmount > balance) {
      return reply.status(400).send({
        error:           'Amount exceeds available balance',
        current_balance: balance,
        requested:       withdrawAmount,
      })
    }

    const payout_details = {
      bank_name,
      account_name,
      account_number,
      country,
      ...(swift_code     && { swift_code }),
      ...(iban           && { iban }),
      ...(routing_number && { routing_number }),
    }

    let payoutId: string

    await db.transaction(async (trx) => {
      // Deduct balance immediately to prevent double-withdrawal
      await trx('merchants')
        .where({ id: merchant.id })
        .decrement('balance', withdrawAmount)

      const [payout] = await trx('payouts')
        .insert({
          merchant_id:    merchant.id,
          amount:         withdrawAmount,
          method:         'bank_transfer',
          status:         'pending',
          payout_details,
        })
        .returning('id')

      payoutId = payout.id
    })

    console.log(`[Payout] Bank transfer requested: merchant ${merchant.name} $${withdrawAmount}`)

    return reply.status(201).send({
      message:   'Withdrawal request received. We will process it within 2–5 business days.',
      payout_id: payoutId!,
      amount:    withdrawAmount,
      method:    'bank_transfer',
      status:    'pending',
    })
  })

  // ── MOBILE MONEY WITHDRAWAL (stub — live when Nardo Pay keys arrive) ──────
  server.post('/merchants/payout/mobile-money', async (request, reply) => {
    const { api_key, amount, phone, currency } = request.body as {
      api_key:  string
      amount?:  number
      phone:    string
      currency: string
    }

    if (!api_key) return reply.status(401).send({ error: 'API key required' })
    if (!phone || !currency) {
      return reply.status(400).send({ error: 'phone and currency are required' })
    }

    const merchant = await getMerchant(api_key)
    if (!merchant) return reply.status(401).send({ error: 'Invalid API key' })

    const balance        = Number(merchant.balance)
    const withdrawAmount = amount ? Number(amount) : balance

    if (withdrawAmount < MIN_WITHDRAWAL) {
      return reply.status(400).send({
        error:           `Minimum withdrawal is $${MIN_WITHDRAWAL}`,
        current_balance: balance,
      })
    }

    if (withdrawAmount > balance) {
      return reply.status(400).send({
        error:           'Amount exceeds available balance',
        current_balance: balance,
      })
    }

    // FX rates (stub — replace with live Nardo Pay rates when keys available)
    const FX: Record<string, number> = {
      KES: 129.5, NGN: 1580, GHS: 15.2, ZAR: 18.4,
      UGX: 3720,  TZS: 2590, ZMW: 25.8, XOF: 605,
    }
    const rate         = FX[currency] || 1
    const local_amount = Number((withdrawAmount * rate).toFixed(2))

    let payoutId: string

    await db.transaction(async (trx) => {
      await trx('merchants')
        .where({ id: merchant.id })
        .decrement('balance', withdrawAmount)

      const [payout] = await trx('payouts')
        .insert({
          merchant_id:    merchant.id,
          amount:         withdrawAmount,
          method:         'mobile_money',
          status:         'pending',
          payout_details: { phone, currency, local_amount },
        })
        .returning('id')

      payoutId = payout.id
    })

    console.log(`[Payout] Mobile money requested: merchant ${merchant.name} $${withdrawAmount} → ${currency} ${local_amount} to ${phone}`)

    return reply.status(201).send({
      message:      'Mobile money withdrawal request received. Processing within 24 hours.',
      payout_id:    payoutId!,
      amount:       withdrawAmount,
      local_amount,
      currency,
      phone,
      method:       'mobile_money',
      status:       'pending',
      stub:         true,
    })
  })

  // ── STRIPE CONNECT ONBOARDING ─────────────────────────────────────────────
  server.post('/merchants/connect/begin', async (request, reply) => {
    const { api_key, email } = request.body as { api_key: string; email: string }

    if (!api_key || !email) {
      return reply.status(400).send({ error: 'api_key and email required' })
    }

    const merchant = await getMerchant(api_key)
    if (!merchant) return reply.status(401).send({ error: 'Invalid API key' })

    const APP_URL = process.env.APP_URL || 'https://dashboard.synthpay.tech'

    let stripeAccountId = merchant.stripe_account_id

    if (!stripeAccountId) {
      const account = await stripe.accounts.create({
        type:  'express',
        email,
        capabilities: { transfers: { requested: true } },
        metadata: { merchant_id: merchant.id, platform: 'synthpay' },
      })
      stripeAccountId = account.id

      await db('merchants')
        .where({ id: merchant.id })
        .update({ stripe_account_id: stripeAccountId, email })
    }

    const accountLink = await stripe.accountLinks.create({
      account:     stripeAccountId,
      refresh_url: `${APP_URL}/withdraw?connect=refresh`,
      return_url:  `${APP_URL}/withdraw?connect=success`,
      type:        'account_onboarding',
    })

    return reply.send({ onboarding_url: accountLink.url })
  })

  // ── STRIPE CONNECT PAYOUT ─────────────────────────────────────────────────
  server.post('/merchants/payout/stripe', async (request, reply) => {
    const { api_key, amount } = request.body as { api_key: string; amount?: number }

    if (!api_key) return reply.status(401).send({ error: 'API key required' })

    const merchant = await getMerchant(api_key)
    if (!merchant) return reply.status(401).send({ error: 'Invalid API key' })

    if (!merchant.stripe_account_id) {
      return reply.status(400).send({
        error:            'Stripe account not connected. Complete onboarding first.',
        needs_onboarding: true,
      })
    }

    const balance        = Number(merchant.balance)
    const withdrawAmount = amount ? Number(amount) : balance

    if (withdrawAmount < MIN_WITHDRAWAL) {
      return reply.status(400).send({
        error:           `Minimum withdrawal is $${MIN_WITHDRAWAL}`,
        current_balance: balance,
      })
    }

    if (withdrawAmount > balance) {
      return reply.status(400).send({
        error:           'Amount exceeds available balance',
        current_balance: balance,
      })
    }

    const amountCents = Math.floor(withdrawAmount * 100)

    const transfer = await stripe.transfers.create({
      amount:      amountCents,
      currency:    'usd',
      destination: merchant.stripe_account_id,
      metadata:    { merchant_id: merchant.id, platform: 'synthpay' },
      description: `SynthPay payout for ${merchant.name}`,
    })

    let payoutId: string

    await db.transaction(async (trx) => {
      await trx('merchants')
        .where({ id: merchant.id })
        .decrement('balance', withdrawAmount)

      const [payout] = await trx('payouts')
        .insert({
          merchant_id:        merchant.id,
          amount:             withdrawAmount,
          method:             'stripe_connect',
          status:             'pending',           // confirmed via webhook, not here
          stripe_transfer_id: transfer.id,
          payout_details:     { stripe_account_id: merchant.stripe_account_id },
        })
        .returning('id')

      payoutId = payout.id
    })

    console.log(`[Payout] Stripe Connect transfer created: merchant ${merchant.name} $${withdrawAmount} → ${transfer.id}`)

    return reply.send({
      message:            'Payout initiated. Funds arrive in 1–7 business days.',
      payout_id:          payoutId!,
      amount:             withdrawAmount,
      stripe_transfer_id: transfer.id,
      method:             'stripe_connect',
      status:             'pending',
    })
  })

  // ── STRIPE CONNECT WEBHOOK ────────────────────────────────────────────────
  // Listens for transfer.paid / transfer.failed
  // Register this as a separate endpoint in Stripe Dashboard (Connected accounts scope)
  server.post('/merchants/connect-webhook', {
    config: { rawBody: true }
  }, async (request, reply) => {
    const sig = request.headers['stripe-signature'] as string
    if (!sig) return reply.status(400).send({ error: 'Missing stripe-signature header' })

    if (!process.env.STRIPE_CONNECT_WEBHOOK_SECRET) {
      console.warn('[Stripe Connect webhook] STRIPE_CONNECT_WEBHOOK_SECRET not set — skipping verification')
      return reply.send({ received: true })
    }

    let event: any
    try {
      event = stripe.webhooks.constructEvent(
        (request as any).rawBody || JSON.stringify(request.body),
        sig,
        process.env.STRIPE_CONNECT_WEBHOOK_SECRET
      )
    } catch (err: any) {
      console.error('[Stripe Connect webhook] Signature verification failed:', err.message)
      return reply.status(400).send({ error: `Webhook error: ${err.message}` })
    }

    if (event.type === 'transfer.paid') {
      const transfer = event.data.object
      await db('payouts')
        .where({ stripe_transfer_id: transfer.id })
        .update({ status: 'completed', updated_at: new Date() })

      console.log(`[Stripe Connect] Transfer paid: ${transfer.id}`)
    }

    if (event.type === 'transfer.failed') {
      const transfer = event.data.object
      const payout   = await db('payouts')
        .where({ stripe_transfer_id: transfer.id, status: 'pending' })
        .first()

      if (payout) {
        // Credit balance back if transfer failed
        await db.transaction(async (trx) => {
          await trx('merchants')
            .where({ id: payout.merchant_id })
            .increment('balance', payout.amount)

          await trx('payouts')
            .where({ id: payout.id })
            .update({
              status:     'failed',
              notes:      'Stripe transfer failed — balance restored',
              updated_at: new Date(),
            })
        })

        console.log(`[Stripe Connect] Transfer failed, balance restored: ${transfer.id}`)
      }
    }

    return reply.send({ received: true })
  })

  // ── GET PAYOUT HISTORY ────────────────────────────────────────────────────
  server.get('/merchants/payouts', async (request, reply) => {
    const api_key = request.headers['x-api-key'] as string
    if (!api_key) return reply.status(401).send({ error: 'API key required' })

    const merchant = await getMerchant(api_key)
    if (!merchant) return reply.status(401).send({ error: 'Invalid API key' })

    const payouts = await db('payouts')
      .where({ merchant_id: merchant.id })
      .orderBy('created_at', 'desc')
      .limit(50)
      .select('id', 'amount', 'method', 'status', 'stripe_transfer_id', 'payout_details', 'notes', 'created_at', 'updated_at')

    const totalPaidOut = payouts
      .filter((p: any) => p.status === 'completed')
      .reduce((sum: number, p: any) => sum + Number(p.amount), 0)

    return reply.send({
      merchant_id:    merchant.id,
      total_paid_out: totalPaidOut,
      payouts:        payouts.map((p: any) => ({
        ...p,
        amount: Number(p.amount),
        // payout_details is JSONB — pg driver returns it as an object already
        payout_details: p.payout_details || {},
      })),
    })
  })

  // ── LEGACY ROUTE — kept for backward compat, returns guidance ────────────
  server.post('/merchants/payout/request', async (request, reply) => {
    const { api_key } = request.body as { api_key: string }
    if (!api_key) return reply.status(401).send({ error: 'API key required' })

    const merchant = await getMerchant(api_key)
    if (!merchant) return reply.status(401).send({ error: 'Invalid API key' })

    // If merchant has Stripe Connect set up, route them there
    if (merchant.stripe_account_id) {
      const balance = Number(merchant.balance)
      if (balance < MIN_WITHDRAWAL) {
        return reply.status(400).send({
          error:           `Minimum withdrawal is $${MIN_WITHDRAWAL}`,
          current_balance: balance,
        })
      }
      return reply.redirect(307, '/merchants/payout/stripe')
    }

    return reply.status(400).send({
      error:   'Please use the withdrawal dashboard to select a payout method.',
      methods: {
        bank_transfer: 'POST /merchants/payout/bank-transfer',
        mobile_money:  'POST /merchants/payout/mobile-money',
        stripe:        'POST /merchants/payout/stripe (requires Stripe Connect onboarding first)',
      },
    })
  })
}
