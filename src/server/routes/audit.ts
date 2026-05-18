import { FastifyInstance } from 'fastify'
import { createHash } from 'crypto'
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
  // Returns all entries with their individual SHA-256 entry_hash for independent verification
  server.get('/audit/ledger', async (request, reply) => {
    try {
      // Must be ASC so we can compute the hash chain in order
      const entries = await db('ledger as l')
        .join('merchants as m', 'l.merchant_id', 'm.id')
        .orderBy('l.created_at', 'asc')
        .select(
          'l.id',
          'l.user_id',
          'l.merchant_id',
          'l.amount',
          'l.platform_fee',
          'l.merchant_receives',
          'l.user_balance_after',
          'l.created_at',
          'm.name as merchant_name'
        )

      // Compute per-entry hash using the same formula as audit.ts
      // SHA256(id | user_id | merchant_id | amount | fee | timestamp | prev_hash)
      let previousHash = '0000000000000000'
      const enriched = entries.map(entry => {
        const amount = Number(entry.amount)
        const fee    = Number(entry.platform_fee)
        const data   = `${entry.id}|${entry.user_id}|${entry.merchant_id}|${amount}|${fee}|${entry.created_at}|${previousHash}`
        const entryHash = createHash('sha256').update(data).digest('hex')
        previousHash = entryHash
        return {
          id:                entry.id,
          merchant_name:     entry.merchant_name,
          amount:            amount,
          platform_fee:      fee,
          merchant_receives: Number(entry.merchant_receives),
          user_balance_after: Number(entry.user_balance_after),
          created_at:        entry.created_at,
          prev_hash:         previousHash === entryHash ? '0000000000000000' : previousHash,
          entry_hash:        entryHash
        }
      })

      // Return newest-first for display, but hashes are computed oldest-first (correct)
      return reply.send({ entries: enriched.reverse(), total: enriched.length })
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