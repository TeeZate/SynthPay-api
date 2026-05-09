import { FastifyInstance } from 'fastify'
import { db } from '../../db/index'

const ADMIN_SECRET = process.env.ADMIN_SECRET || 'synthpay_admin_2026'

// ── Admin auth middleware ─────────────────────────────────────────────────────
async function requireAdmin(request: any, reply: any) {
  const secret = request.headers['x-admin-secret'] as string
  if (!secret || secret !== ADMIN_SECRET) {
    return reply.status(401).send({ error: 'Unauthorized' })
  }
}

export const adminRoutes = async (server: FastifyInstance) => {

  // ── Overview stats ───────────────────────────────────────────────────────
  server.get('/admin/overview', { preHandler: requireAdmin }, async (request, reply) => {
    const [
      merchantCount,
      userCount,
      ledgerStats,
      todayStats,
      recentTx
    ] = await Promise.all([
      db('merchants').where({ active: true }).count('id as count').first(),
      db('users').count('id as count').first(),
      db('ledger').select(
        db.raw('COUNT(*) as total_transactions'),
        db.raw('SUM(amount) as total_volume'),
        db.raw('SUM(platform_fee) as total_fees'),
        db.raw('SUM(merchant_receives) as total_merchant_payouts')
      ).first(),
      db('ledger')
        .where('created_at', '>=', db.raw("NOW() - INTERVAL '24 hours'"))
        .select(
          db.raw('COUNT(*) as transactions'),
          db.raw('SUM(amount) as volume'),
          db.raw('SUM(platform_fee) as fees')
        ).first(),
      db('ledger as l')
        .join('merchants as m', 'l.merchant_id', 'm.id')
        .orderBy('l.created_at', 'desc')
        .limit(10)
        .select('l.*', 'm.name as merchant_name')
    ])

    return reply.send({
      merchants:          Number(merchantCount?.count || 0),
      users:              Number(userCount?.count || 0),
      total_transactions: Number(ledgerStats?.total_transactions || 0),
      total_volume:       Number(ledgerStats?.total_volume || 0),
      total_fees:         Number(ledgerStats?.total_fees || 0),
      total_merchant_payouts: Number(ledgerStats?.total_merchant_payouts || 0),
      today_transactions: Number(todayStats?.transactions || 0),
      today_volume:       Number(todayStats?.volume || 0),
      today_fees:         Number(todayStats?.fees || 0),
      recent_transactions: recentTx
    })
  })

  // ── All merchants ────────────────────────────────────────────────────────
  server.get('/admin/merchants', { preHandler: requireAdmin }, async (request, reply) => {
    const merchants = await db('merchants as m')
      .leftJoin(db('ledger').groupBy('merchant_id')
        .select('merchant_id', db.raw('COUNT(*) as tx_count'), db.raw('SUM(amount) as volume'))
        .as('l'), 'l.merchant_id', 'm.id')
      .select(
        'm.id', 'm.name', 'm.balance', 'm.total_earned',
        'm.active', 'm.created_at',
        db.raw('COALESCE(l.tx_count, 0) as transaction_count'),
        db.raw('COALESCE(l.volume, 0) as total_volume')
      )
      .orderBy('m.created_at', 'desc')

    return reply.send({ merchants })
  })

  // ── Single merchant detail ────────────────────────────────────────────────
  server.get('/admin/merchants/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string }

    const [merchant, endpoints, transactions] = await Promise.all([
      db('merchants').where({ id }).first(),
      db('endpoints').where({ merchant_id: id }),
      db('ledger').where({ merchant_id: id }).orderBy('created_at', 'desc').limit(50)
    ])

    if (!merchant) return reply.status(404).send({ error: 'Merchant not found' })

    return reply.send({ merchant, endpoints, transactions })
  })

  // ── Toggle merchant active status ────────────────────────────────────────
  server.patch('/admin/merchants/:id/toggle', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const merchant = await db('merchants').where({ id }).first()
    if (!merchant) return reply.status(404).send({ error: 'Not found' })

    await db('merchants').where({ id }).update({ active: !merchant.active })
    return reply.send({ id, active: !merchant.active })
  })

  // ── All users ────────────────────────────────────────────────────────────
  server.get('/admin/users', { preHandler: requireAdmin }, async (request, reply) => {
    const users = await db('users as u')
      .leftJoin(db('ledger').groupBy('user_id')
        .select('user_id', db.raw('COUNT(*) as tx_count'), db.raw('SUM(amount) as total_spent'))
        .as('l'), 'l.user_id', 'u.id')
      .leftJoin(db('topups').where({ status: 'completed' }).groupBy('user_id')
        .select('user_id', db.raw('SUM(amount) as total_deposited'))
        .as('t'), 't.user_id', 'u.id')
      .select(
        'u.id', 'u.balance', 'u.created_at',
        db.raw('COALESCE(l.tx_count, 0) as transaction_count'),
        db.raw('COALESCE(l.total_spent, 0) as total_spent'),
        db.raw('COALESCE(t.total_deposited, 0) as total_deposited')
      )
      .orderBy('u.created_at', 'desc')

    return reply.send({ users })
  })

  // ── All transactions (paginated) ─────────────────────────────────────────
  server.get('/admin/transactions', { preHandler: requireAdmin }, async (request, reply) => {
    const { page = 1, limit = 50, merchant_id } = request.query as {
      page?: number; limit?: number; merchant_id?: string
    }
    const offset = (Number(page) - 1) * Number(limit)

    let query = db('ledger as l')
      .join('merchants as m', 'l.merchant_id', 'm.id')
      .orderBy('l.created_at', 'desc')
      .limit(Number(limit))
      .offset(offset)
      .select('l.*', 'm.name as merchant_name')

    if (merchant_id) query = query.where('l.merchant_id', merchant_id)

    const [transactions, totalRes] = await Promise.all([
      query,
      db('ledger').count('id as count').first()
    ])

    return reply.send({
      transactions,
      total: Number(totalRes?.count || 0),
      page:  Number(page),
      limit: Number(limit)
    })
  })

  // ── Revenue over time (last 30 days) ─────────────────────────────────────
  server.get('/admin/revenue', { preHandler: requireAdmin }, async (request, reply) => {
    const daily = await db('ledger')
      .select(
        db.raw("DATE(created_at) as date"),
        db.raw('COUNT(*) as transactions'),
        db.raw('SUM(amount) as volume'),
        db.raw('SUM(platform_fee) as fees')
      )
      .where('created_at', '>=', db.raw("NOW() - INTERVAL '30 days'"))
      .groupByRaw('DATE(created_at)')
      .orderBy('date', 'asc')

    return reply.send({ daily })
  })

  // ── Platform health ───────────────────────────────────────────────────────
  server.get('/admin/health', { preHandler: requireAdmin }, async (request, reply) => {
    const [dbCheck, auditLog] = await Promise.all([
      db('ledger').count('id as count').first(),
      db('audit_log').orderBy('run_at', 'desc').first()
    ])

    return reply.send({
      database:     'connected',
      total_ledger_entries: Number(dbCheck?.count || 0),
      last_audit:   auditLog?.run_at || null,
      audit_status: auditLog?.status || 'never_run',
      server_time:  new Date().toISOString()
    })
  })
}