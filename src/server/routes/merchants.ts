import { FastifyInstance } from 'fastify'
import { db } from '../../db/index'
import { randomBytes } from 'crypto'

export const merchantRoutes = async (server: FastifyInstance) => {

  // ── Register a new merchant ───────────────────────────────────────────────
  server.post('/merchants/register', async (request, reply) => {
    const { name, email } = request.body as { name: string; email?: string }

    if (!name || name.trim().length < 2) {
      return reply.status(400).send({ error: 'Merchant name is required' })
    }

    const api_key = `tl_${randomBytes(32).toString('hex')}`

    const [merchant] = await db('merchants')
      .insert({
        name:         name.trim(),
        api_key,
        balance:      0,
        total_earned: 0,
        active:       true
      })
      .returning(['id', 'name', 'api_key', 'created_at'])

    return reply.status(201).send({
      message:     'Merchant registered successfully',
      merchant_id: merchant.id,
      name:        merchant.name,
      api_key:     merchant.api_key,
      warning:     'Save your api_key — it will not be shown again'
    })
  })

  // ── Register a priced endpoint ────────────────────────────────────────────
  server.post('/merchants/endpoints', async (request, reply) => {
    const { api_key, path, price, service_name, description, category } = request.body as {
      api_key:      string
      path:         string
      price:        number
      service_name: string
      description:  string
      category:     string
    }

    const merchant = await db('merchants')
      .where({ api_key, active: true })
      .first()

    if (!merchant) {
      return reply.status(401).send({ error: 'Invalid API key' })
    }

    if (!path || price <= 0) {
      return reply.status(400).send({ error: 'Valid path and price required' })
    }

    const [endpoint] = await db('endpoints')
      .insert({
        merchant_id:  merchant.id,
        path:         path.trim(),
        price:        Number(price.toFixed(8)),
        active:       true,
        service_name: (service_name || path).trim(),
        description:  (description || 'API service').trim(),
        category:     (category || 'General').trim()
      })
      .returning(['id', 'path', 'price', 'service_name', 'description', 'category'])

    return reply.status(201).send({
      message:      'Endpoint registered',
      endpoint_id:  endpoint.id,
      path:         endpoint.path,
      price:        endpoint.price,
      service_name: endpoint.service_name,
      description:  endpoint.description,
      category:     endpoint.category
    })
  })

  // ── Merchant dashboard ────────────────────────────────────────────────────
  server.get('/merchants/dashboard', async (request, reply) => {
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

    const transactions = await db('ledger')
      .where({ merchant_id: merchant.id })
      .orderBy('created_at', 'desc')
      .limit(50)

    const endpoints = await db('endpoints')
      .where({ merchant_id: merchant.id })
      .select('id', 'path', 'price', 'active', 'service_name', 'description', 'category')
      .orderBy('created_at', 'asc')

    const today = new Date()
    today.setHours(0, 0, 0, 0)

    const todayEarnings = await db('ledger')
      .where({ merchant_id: merchant.id })
      .where('created_at', '>=', today)
      .sum('merchant_receives as total')
      .first()

    return reply.send({
      merchant: {
        id:           merchant.id,
        name:         merchant.name,
        balance:      Number(merchant.balance),
        total_earned: Number(merchant.total_earned),
        today_earned: Number(todayEarnings?.total || 0)
      },
      endpoints,
      recent_transactions: transactions
    })
  })

  // ── Update an endpoint (price, active, service_name, description, category) ─
  server.patch('/merchants/endpoints/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const { api_key, price, active, service_name, description, category } = request.body as {
      api_key:       string
      price?:        number
      active?:       boolean
      service_name?: string
      description?:  string
      category?:     string
    }

    if (!api_key) {
      return reply.status(401).send({ error: 'API key required' })
    }

    const merchant = await db('merchants')
      .where({ api_key, active: true })
      .first()

    if (!merchant) {
      return reply.status(401).send({ error: 'Invalid API key' })
    }

    // Verify the endpoint belongs to this merchant
    const endpoint = await db('endpoints')
      .where({ id, merchant_id: merchant.id })
      .first()

    if (!endpoint) {
      return reply.status(404).send({ error: 'Endpoint not found' })
    }

    // Build update payload — only include provided fields
    const updates: Record<string, any> = {}
    if (price !== undefined) {
      if (price <= 0) return reply.status(400).send({ error: 'Price must be greater than 0' })
      updates.price = Number(price.toFixed(8))
    }
    if (active !== undefined) updates.active = active
    if (service_name !== undefined) updates.service_name = service_name.trim()
    if (description  !== undefined) updates.description  = description.trim()
    if (category     !== undefined) updates.category     = category.trim()

    if (Object.keys(updates).length === 0) {
      return reply.status(400).send({ error: 'No fields to update' })
    }

    const [updated] = await db('endpoints')
      .where({ id })
      .update(updates)
      .returning(['id', 'path', 'price', 'active', 'service_name', 'description', 'category'])

    return reply.send({
      message:  'Endpoint updated',
      endpoint: updated
    })
  })

  // ── Get endpoints for a merchant (used by middleware) ─────────────────────
  server.get('/merchants/endpoints', async (request, reply) => {
    const api_key = request.headers['x-api-key'] as string

    const merchant = await db('merchants')
      .where({ api_key, active: true })
      .first()

    if (!merchant) {
      return reply.status(401).send({ error: 'Invalid API key' })
    }

    const endpoints = await db('endpoints')
      .where({ merchant_id: merchant.id, active: true })

    return reply.send({ endpoints })
  })

  // ── Public marketplace — no auth required ─────────────────────────────────
  server.get('/marketplace', async (request, reply) => {
    // Get all active merchants with their active endpoints
    const endpoints = await db('endpoints as e')
      .join('merchants as m', 'e.merchant_id', 'm.id')
      .where('e.active', true)
      .where('m.active', true)
      .whereNotNull('e.service_name')
      .select(
        'e.id          as endpoint_id',
        'e.path',
        'e.price',
        'e.service_name',
        'e.description',
        'e.category',
        'm.id          as merchant_id',
        'm.name        as merchant_name'
      )
      .orderBy('m.name', 'asc')

    // Group by merchant
    const merchantMap: Record<string, any> = {}
    for (const row of endpoints) {
      if (!merchantMap[row.merchant_id]) {
        merchantMap[row.merchant_id] = {
          merchant_id:   row.merchant_id,
          merchant_name: row.merchant_name,
          services:      []
        }
      }
      merchantMap[row.merchant_id].services.push({
        endpoint_id:  row.endpoint_id,
        path:         row.path,
        price:        Number(row.price),
        service_name: row.service_name,
        description:  row.description,
        category:     row.category
      })
    }

    return reply.send({
      merchants: Object.values(merchantMap),
      total:     Object.keys(merchantMap).length
    })
  })
}
