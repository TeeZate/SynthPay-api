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

  // ── Merchant analytics ────────────────────────────────────────────────────
  server.get('/merchants/analytics', async (request, reply) => {
    const api_key = request.headers['x-api-key'] as string
    if (!api_key) return reply.status(401).send({ error: 'API key required' })

    const merchant = await db('merchants').where({ api_key, active: true }).first()
    if (!merchant) return reply.status(401).send({ error: 'Invalid API key' })

    const now       = new Date()
    const ago24h    = new Date(now.getTime() - 24 * 60 * 60 * 1000)
    const ago7d     = new Date(now.getTime() - 7  * 24 * 60 * 60 * 1000)
    const ago30d    = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    const todayStart = new Date(now); todayStart.setHours(0,0,0,0)
    const yesterdayStart = new Date(todayStart.getTime() - 86400000)

    const [
      endpoints,
      endpointStats,
      endpointStats7d,
      endpointStats24h,
      daily,
      todaySummary,
      yesterdaySummary,
      week7d,
    ] = await Promise.all([
      // All endpoints
      db('endpoints')
        .where({ merchant_id: merchant.id })
        .select('id', 'path', 'price', 'active', 'service_name', 'description', 'category')
        .orderBy('created_at', 'asc'),

      // All-time per-endpoint stats
      db('ledger')
        .where({ merchant_id: merchant.id })
        .groupBy('endpoint_id')
        .select(
          'endpoint_id',
          db.raw('COUNT(*) as calls'),
          db.raw('SUM(merchant_receives) as revenue'),
          db.raw('MAX(created_at) as last_call_at')
        ),

      // 7d per-endpoint
      db('ledger')
        .where({ merchant_id: merchant.id })
        .where('created_at', '>=', ago7d)
        .groupBy('endpoint_id')
        .select('endpoint_id', db.raw('COUNT(*) as calls'), db.raw('SUM(merchant_receives) as revenue')),

      // 24h per-endpoint
      db('ledger')
        .where({ merchant_id: merchant.id })
        .where('created_at', '>=', ago24h)
        .groupBy('endpoint_id')
        .select('endpoint_id', db.raw('COUNT(*) as calls'), db.raw('SUM(merchant_receives) as revenue')),

      // Daily breakdown — last 30 days
      db('ledger')
        .where({ merchant_id: merchant.id })
        .where('created_at', '>=', ago30d)
        .select(
          db.raw("DATE(created_at) as date"),
          db.raw('COUNT(*) as calls'),
          db.raw('SUM(merchant_receives) as revenue')
        )
        .groupByRaw("DATE(created_at)")
        .orderBy('date', 'asc'),

      // Today
      db('ledger').where({ merchant_id: merchant.id }).where('created_at', '>=', todayStart)
        .select(db.raw('COUNT(*) as calls'), db.raw('SUM(merchant_receives) as revenue')).first(),

      // Yesterday
      db('ledger').where({ merchant_id: merchant.id })
        .where('created_at', '>=', yesterdayStart).where('created_at', '<', todayStart)
        .select(db.raw('COUNT(*) as calls'), db.raw('SUM(merchant_receives) as revenue')).first(),

      // 7d total
      db('ledger').where({ merchant_id: merchant.id }).where('created_at', '>=', ago7d)
        .select(db.raw('COUNT(*) as calls'), db.raw('SUM(merchant_receives) as revenue')).first(),
    ])

    // Merge endpoint stats
    const statsMap    = Object.fromEntries(endpointStats.map((r: any)   => [r.endpoint_id, r]))
    const stats7dMap  = Object.fromEntries(endpointStats7d.map((r: any) => [r.endpoint_id, r]))
    const stats24hMap = Object.fromEntries(endpointStats24h.map((r: any)=> [r.endpoint_id, r]))

    const enrichedEndpoints = endpoints.map((ep: any) => {
      const all  = statsMap[ep.id]   || {}
      const s7d  = stats7dMap[ep.id] || {}
      const s24h = stats24hMap[ep.id]|| {}
      const totalCalls = Number(all.calls || 0)
      return {
        ...ep,
        price:          Number(ep.price),
        calls_total:    totalCalls,
        calls_7d:       Number(s7d.calls   || 0),
        calls_24h:      Number(s24h.calls  || 0),
        revenue_total:  Number(all.revenue  || 0),
        revenue_7d:     Number(s7d.revenue  || 0),
        revenue_24h:    Number(s24h.revenue || 0),
        last_call_at:   all.last_call_at || null,
        avg_revenue_per_call: totalCalls > 0 ? Number(all.revenue || 0) / totalCalls : Number(ep.price),
      }
    }).sort((a: any, b: any) => b.calls_total - a.calls_total)

    return reply.send({
      merchant: {
        id:           merchant.id,
        name:         merchant.name,
        balance:      Number(merchant.balance),
        total_earned: Number(merchant.total_earned),
      },
      summary: {
        today_calls:       Number(todaySummary?.calls    || 0),
        today_revenue:     Number(todaySummary?.revenue  || 0),
        yesterday_calls:   Number(yesterdaySummary?.calls   || 0),
        yesterday_revenue: Number(yesterdaySummary?.revenue || 0),
        week_calls:        Number(week7d?.calls    || 0),
        week_revenue:      Number(week7d?.revenue  || 0),
      },
      endpoints: enrichedEndpoints,
      daily: daily.map((d: any) => ({
        date:    d.date,
        calls:   Number(d.calls),
        revenue: Number(d.revenue),
      })),
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
