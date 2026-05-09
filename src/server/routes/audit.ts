import { FastifyInstance } from 'fastify'
import { db } from '../../db/index'
import { runAudit, getLiveStats } from '../audit'

export const auditRoutes = async (server: FastifyInstance) => {

  // Live ledger stats — computed fresh, no cache, no auth required
  server.get('/audit/live', async (request, reply) => {
    try {
      const stats = await getLiveStats()
      return reply.send(stats)
    } catch (err) {
      console.error('Live audit failed:', err)
      return reply.status(500).send({ error: 'Audit computation failed' })
    }
  })

  // Latest stored audit result
  server.get('/audit/latest', async (request, reply) => {
    const latest = await db('audit_log')
      .orderBy('run_at', 'desc')
      .first()

    if (!latest) {
      return reply.send({ message: 'No audit has been run yet' })
    }

    return reply.send({
      status:        latest.status,
      total_entries: latest.total_entries,
      total_volume:  `$${Number(latest.total_volume).toFixed(6)}`,
      total_fees:    `$${Number(latest.total_fees).toFixed(6)}`,
      chain_hash:    latest.chain_hash,
      anomalies:     latest.anomalies,
      run_at:        latest.run_at
    })
  })

  // Public ledger entries — no auth required
  server.get('/audit/ledger', async (request, reply) => {
    const entries = await db('ledger as l')
      .join('merchants as m', 'l.merchant_id', 'm.id')
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

    return reply.send({ entries, total: entries.length })
  })

  // Trigger a full audit manually
  server.post('/audit/run', async (request, reply) => {
    try {
      const result = await runAudit()
      return reply.send(result)
    } catch (err) {
      console.error('Manual audit failed:', err)
      return reply.status(500).send({ error: 'Audit failed' })
    }
  })
}