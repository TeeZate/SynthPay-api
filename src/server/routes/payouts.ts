import { FastifyInstance } from 'fastify'
import { db } from '../../db/index'
import Stripe from 'stripe'
import dotenv from 'dotenv'
import { resolve } from 'path'

dotenv.config({ path: resolve(process.cwd(), '.env') })

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2026-03-25.dahlia'
})

const APP_URL = process.env.APP_URL || 'http://localhost:3000'

export const payoutRoutes = async (server: FastifyInstance) => {

  // ── 4.02 BEGIN STRIPE CONNECT ONBOARDING ─────────────────────
  server.post('/merchants/connect/begin', async (request, reply) => {
    const { api_key, email } = request.body as {
      api_key: string
      email:   string
    }

    if (!api_key || !email) {
      return reply.status(400).send({
        error: 'api_key and email required'
      })
    }

    const merchant = await db('merchants')
      .where({ api_key, active: true })
      .first()

    if (!merchant) {
      return reply.status(401).send({ error: 'Invalid API key' })
    }

    // Create Stripe Connect account if not exists
    let stripeAccountId = merchant.stripe_account_id

    if (!stripeAccountId) {
      const account = await stripe.accounts.create({
        type:         'express',
        email,
        capabilities: {
          transfers: { requested: true }
        },
        metadata: {
          merchant_id: merchant.id,
          platform:    'synthpay'
        }
      })

      stripeAccountId = account.id

      await db('merchants')
        .where({ id: merchant.id })
        .update({
          stripe_account_id: stripeAccountId,
          email
        })
    }

    // Create onboarding link
    const accountLink = await stripe.accountLinks.create({
      account:     stripeAccountId,
      refresh_url: `${APP_URL}/merchants/connect/refresh`,
      return_url:  `${APP_URL}/merchants/connect/return`,
      type:        'account_onboarding',
    })

    return reply.send({
      onboarding_url: accountLink.url,
      message:        'Visit the onboarding_url to complete Stripe setup'
    })
  })

  // ── 4.03 HANDLE CONNECT RETURN ───────────────────────────────
  server.get('/merchants/connect/return', async (request, reply) => {
    return reply.send({
      message: 'Stripe Connect onboarding complete. You can now receive payouts.',
      next:    'Use POST /merchants/payout/request to withdraw earnings'
    })
  })

  server.get('/merchants/connect/refresh', async (request, reply) => {
    return reply.send({
      message: 'Onboarding link expired. Request a new one via POST /merchants/connect/begin'
    })
  })

  // ── 4.04 REQUEST PAYOUT ───────────────────────────────────────
  server.post('/merchants/payout/request', async (request, reply) => {
    const { api_key } = request.body as { api_key: string }

    if (!api_key) {
      return reply.status(400).send({ error: 'api_key required' })
    }

    const merchant = await db('merchants')
      .where({ api_key, active: true })
      .first()

    if (!merchant) {
      return reply.status(401).send({ error: 'Invalid API key' })
    }

    // Must have connected Stripe account
    if (!merchant.stripe_account_id) {
      return reply.status(400).send({
        error:       'Stripe account not connected',
        message:     'Complete Stripe Connect onboarding first',
        onboard_url: `${APP_URL}/merchants/connect/begin`
      })
    }

    const balance = Number(merchant.balance)

    // Minimum payout threshold
    if (balance < 1.00) {
      return reply.status(400).send({
        error:           'Insufficient balance for payout',
        current_balance: balance,
        minimum_payout:  1.00
      })
    }

    // Create transfer to merchant Stripe account
    const amountCents = Math.floor(balance * 100)

    const transfer = await stripe.transfers.create({
      amount:      amountCents,
      currency:    'usd',
      destination: merchant.stripe_account_id,
      metadata: {
        merchant_id: merchant.id,
        platform:    'synthpay'
      },
      description: `SynthPay payout for merchant ${merchant.name}`
    })

    // Record payout and zero balance atomically
    await db.transaction(async (trx) => {
      // Zero out merchant balance
      await trx('merchants')
        .where({ id: merchant.id })
        .update({ balance: 0 })

      // Record in payouts table
      await trx('payouts').insert({
        merchant_id:        merchant.id,
        amount:             balance,
        stripe_transfer_id: transfer.id,
        status:             'completed'
      })
    })

    console.log(`✅ Payout sent: merchant ${merchant.name} $${balance}`)

    return reply.send({
      message:            'Payout initiated successfully',
      amount:             balance,
      stripe_transfer_id: transfer.id,
      new_balance:        0
    })
  })

  // ── 4.07 PAYOUT HISTORY ───────────────────────────────────────
  server.get('/merchants/payouts', async (request, reply) => {
    const api_key = request.headers['x-api-key'] as string

    if (!api_key) {
      return reply.status(401).send({ error: 'API key required' })
    }

    const merchant = await db('merchants')
      .where({ api_key, active: true })
      .first()

    if (!merchant) {
      return reply.status(401).send({ error: 'Invalid API key' })
    }

    const payouts = await db('payouts')
      .where({ merchant_id: merchant.id })
      .orderBy('created_at', 'desc')
      .limit(50)

    const total = payouts
      .filter((p: any) => p.status === 'completed')
      .reduce((sum: number, p: any) => sum + Number(p.amount), 0)

    return reply.send({
      merchant_id:   merchant.id,
      total_paid_out: total,
      payouts
    })
  })
}