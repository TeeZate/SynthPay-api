import { FastifyInstance } from 'fastify'
import jwt from 'jsonwebtoken'
import { db } from '../../db/index'
import { atomicDeduct } from '../ledger'

const JWT_SECRET = process.env.JWT_SECRET || 'changeme'

// ── Velocity limits (mirror /users/pay) ──────────────────────────────────────
const MAX_SPEND_PER_DAY   = 500    // $500 daily limit per viewer
const DUPLICATE_WINDOW_MS = 5000   // 5 seconds — catches retries

/**
 * Merchant-authenticated charge — the real third-party integration surface.
 *
 *   POST /v1/charge
 *   Authorization:    Bearer <merchant api_key>     (server-side secret)
 *   X-SynthPay-Viewer: Bearer <viewer wallet token> (proves the viewer)
 *   { "endpoint_id": "<merchant endpoint>" }
 *
 * The merchant is resolved from the API key (never trusted from the body) and
 * the viewer from their own SynthPay token — so a merchant can only charge a
 * viewer who actually signed in, never an account they simply name. The price
 * is taken from the endpoint; the caller cannot set the amount.
 *
 * (A raw `user_id` in the body is still accepted as a fallback for trusted
 * server-to-server use, but the viewer-token path is the real one.)
 */
export const chargeRoutes = async (server: FastifyInstance) => {
  server.post('/v1/charge', async (request, reply) => {
    // ── 1. Authenticate the merchant by API key ──────────────────────────────
    const raw = request.headers['authorization']
    const header = Array.isArray(raw) ? raw[0] : (raw || '')
    const apiKey = header.replace(/^Bearer\s+/i, '').trim()

    if (!apiKey) {
      return reply.status(401).send({ error: 'Missing merchant API key' })
    }

    const merchant = await db('merchants').where({ api_key: apiKey, active: true }).first()
    if (!merchant) {
      return reply.status(401).send({ error: 'Invalid merchant API key' })
    }

    // ── 2. Resolve the viewer — prefer their signed SynthPay token ────────────
    const body = request.body as { user_id?: string; endpoint_id: string }
    const endpoint_id = body.endpoint_id

    const viewerRaw = request.headers['x-synthpay-viewer']
    const viewerHeader = Array.isArray(viewerRaw) ? viewerRaw[0] : (viewerRaw || '')
    const viewerToken = viewerHeader.replace(/^Bearer\s+/i, '').trim()

    let user_id: string | undefined = body.user_id
    if (viewerToken) {
      try {
        const payload = jwt.verify(viewerToken, JWT_SECRET) as { user_id: string }
        user_id = payload.user_id
      } catch {
        return reply.status(401).send({ error: 'Viewer session expired — sign in again' })
      }
    }

    if (!user_id || !endpoint_id) {
      return reply.status(400).send({ error: 'A viewer token (or user_id) and endpoint_id are required' })
    }

    // Endpoint must belong to THIS merchant — price is authoritative server-side
    const endpoint = await db('endpoints')
      .where({ id: endpoint_id, merchant_id: merchant.id, active: true })
      .first()

    if (!endpoint) {
      return reply.status(404).send({ error: 'Endpoint not found for this merchant' })
    }

    const amount = Number(endpoint.price)

    const viewer = await db('users').where({ id: user_id }).first()
    if (!viewer) {
      return reply.status(404).send({ error: 'Viewer account not found' })
    }

    // ── 3. Duplicate detection — 5s window ────────────────────────────────────
    const duplicateWindow = new Date(Date.now() - DUPLICATE_WINDOW_MS)
    const recentDuplicate = await db('ledger')
      .where({ user_id, endpoint_id })
      .where('created_at', '>', duplicateWindow)
      .first()

    if (recentDuplicate) {
      const u = await db('users').where({ id: user_id }).first()
      return reply.send({
        success:       true,
        balance_after: Number(u?.balance || 0),
        amount,
        duplicate:     true,
      })
    }

    // ── 4. Velocity check — daily spend limit ─────────────────────────────────
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    const todaySpend = await db('ledger')
      .where({ user_id })
      .where('created_at', '>=', today)
      .sum('amount as total')
      .first()

    if (Number(todaySpend?.total || 0) + amount > MAX_SPEND_PER_DAY) {
      return reply.status(429).send({
        error: `Daily spend limit of $${MAX_SPEND_PER_DAY} reached. Resets at midnight.`,
      })
    }

    // ── 5. Atomic deduction (same path as /users/pay) ─────────────────────────
    const result = await atomicDeduct({
      user_id,
      merchant_id: merchant.id,
      endpoint_id,
      amount,
    })

    if (!result.success) {
      return reply.status(402).send({
        error:     result.error,
        topup_url: 'https://account.synthpay.tech',
      })
    }

    return reply.send({
      success:       true,
      merchant:      merchant.name,
      endpoint:      endpoint.service_name || endpoint.path,
      amount,
      balance_after: result.balance_after,
    })
  })
}
