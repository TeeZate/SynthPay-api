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
  // entry_hash and prev_hash are stored in DB at write time, no recomputation needed
  server.get('/audit/ledger', async (request, reply) => {
    try {
      const entries = await db('ledger as l')
        .join('merchants as m', 'l.merchant_id', 'm.id')
        .orderBy('l.created_at', 'desc')
        .select(
          'l.id',
          'l.user_id',
          'l.merchant_id',
          'l.amount',
          'l.platform_fee',
          'l.merchant_receives',
          'l.user_balance_after',
          'l.created_at',
          'l.entry_hash',
          'l.prev_hash',
          'm.name as merchant_name'
        )

      const mapped = entries.map((e: any) => ({
        id:                 e.id,
        merchant_name:      e.merchant_name,
        amount:             Number(e.amount),
        platform_fee:       Number(e.platform_fee),
        merchant_receives:  Number(e.merchant_receives),
        user_balance_after: Number(e.user_balance_after),
        created_at:         e.created_at,
        prev_hash:          e.prev_hash  || '0000000000000000',
        entry_hash:         e.entry_hash || null
      }))

      return reply.send({ entries: mapped, total: mapped.length })
    } catch (err) {
      console.error('Ledger fetch failed:', err)
      return reply.status(500).send({ error: 'Failed to fetch ledger entries' })
    }
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