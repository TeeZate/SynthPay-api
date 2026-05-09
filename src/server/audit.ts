import { db } from '../db/index'
import { createHash } from 'crypto'

interface AuditResult {
  status:          'PASSED' | 'FAILED'
  total_entries:   number
  total_volume:    number
  total_fees:      number
  chain_hash:      string
  anomalies:       number
  anomaly_details: any[]
  run_at:          Date
}

// ── Core audit function ──────────────────────────────────────────────────────
export const runAudit = async (): Promise<AuditResult> => {
  const run_at    = new Date()
  const anomalies: any[] = []

  const entries = await db('ledger')
    .orderBy('created_at', 'asc')
    .select('*')

  let total_volume = 0
  let total_fees   = 0
  let runningHash  = ''
  let previousHash = '0000000000000000'

  for (const entry of entries) {
    const amount        = Number(entry.amount)
    const fee           = Number(entry.platform_fee)
    const merchant_recv = Number(entry.merchant_receives)
    const balance_after = Number(entry.user_balance_after)

    const expectedMerchant = amount - fee
    if (Math.abs(expectedMerchant - merchant_recv) > 0.000001) {
      anomalies.push({ entry_id: entry.id, issue: 'Fee arithmetic mismatch', amount, fee, merchant_receives: merchant_recv, expected_merchant: expectedMerchant })
    }

    if (balance_after < 0) {
      anomalies.push({ entry_id: entry.id, issue: 'Negative balance detected', balance_after })
    }

    total_volume += amount
    total_fees   += fee

    const entryData = `${entry.id}|${entry.user_id}|${entry.merchant_id}|${amount}|${fee}|${entry.created_at}|${previousHash}`
    runningHash  = createHash('sha256').update(entryData).digest('hex')
    previousHash = runningHash
  }

  const users = await db('users').select('id', 'balance')
  for (const user of users) {
    const ledgerTotal = await db('ledger').where({ user_id: user.id }).sum('amount as total').first()
    const topupTotal  = await db('topups').where({ user_id: user.id, status: 'completed' }).sum('amount as total').first()
    const totalSpent     = Number(ledgerTotal?.total || 0)
    const totalDeposited = Number(topupTotal?.total  || 0)
    const expectedBalance = totalDeposited - totalSpent
    const actualBalance   = Number(user.balance)
    if (Math.abs(expectedBalance - actualBalance) > 0.000001) {
      anomalies.push({ user_id: user.id, issue: 'Balance mismatch', expected_balance: expectedBalance, actual_balance: actualBalance, difference: actualBalance - expectedBalance })
    }
  }

  const status     = anomalies.length === 0 ? 'PASSED' : 'FAILED'
  const chain_hash = runningHash || createHash('sha256').update('empty_ledger').digest('hex')

  await db('audit_log').insert({
    run_at,
    status,
    total_entries:   entries.length,
    total_volume:    total_volume.toFixed(8),
    total_fees:      total_fees.toFixed(8),
    chain_hash,
    anomalies:       anomalies.length,
    anomaly_details: anomalies.length > 0 ? JSON.stringify(anomalies) : null
  })

  return { status, total_entries: entries.length, total_volume, total_fees, chain_hash, anomalies: anomalies.length, anomaly_details: anomalies, run_at }
}

// ── Live ledger stats — computed fresh on every call ─────────────────────────
export const getLiveStats = async () => {
  const verified_at = new Date()

  // All ledger entries
  const entries = await db('ledger').orderBy('created_at', 'asc').select('*')

  let total_volume = 0
  let total_fees   = 0
  let anomalies    = 0
  let runningHash  = ''
  let previousHash = '0000000000000000'

  for (const entry of entries) {
    const amount        = Number(entry.amount)
    const fee           = Number(entry.platform_fee)
    const merchant_recv = Number(entry.merchant_receives)

    const expectedMerchant = amount - fee
    if (Math.abs(expectedMerchant - merchant_recv) > 0.000001) anomalies++
    if (Number(entry.user_balance_after) < 0) anomalies++

    total_volume += amount
    total_fees   += fee

    const entryData = `${entry.id}|${entry.user_id}|${entry.merchant_id}|${amount}|${fee}|${entry.created_at}|${previousHash}`
    runningHash  = createHash('sha256').update(entryData).digest('hex')
    previousHash = runningHash
  }

  const chain_hash = runningHash || createHash('sha256').update('empty_ledger').digest('hex')
  const chain_valid = anomalies === 0

  // Aggregate counts
  const [merchantCount, userCount, lastEntry] = await Promise.all([
    db('merchants').where({ active: true }).count('id as count').first(),
    db('users').count('id as count').first(),
    db('ledger').orderBy('created_at', 'desc').first()
  ])

  // Per-merchant breakdown
  const merchantStats = await db('ledger as l')
    .join('merchants as m', 'l.merchant_id', 'm.id')
    .groupBy('m.id', 'm.name')
    .select(
      'm.name as merchant_name',
      db.raw('COUNT(l.id) as call_count'),
      db.raw('SUM(l.amount) as volume'),
      db.raw('SUM(l.merchant_receives) as earned')
    )
    .orderBy('call_count', 'desc')

  return {
    // Integrity
    chain_valid,
    chain_hash,
    anomalies,
    status: chain_valid ? 'PASSED' : 'FAILED',

    // Volume
    total_api_calls:  entries.length,
    total_volume_usd: `$${total_volume.toFixed(6)}`,
    total_fees_usd:   `$${total_fees.toFixed(6)}`,
    total_volume_raw: total_volume,

    // Network
    total_merchants: Number(merchantCount?.count || 0),
    total_users:     Number(userCount?.count     || 0),

    // Activity
    last_transaction: lastEntry?.created_at || null,

    // Per merchant
    merchant_breakdown: merchantStats.map((m: any) => ({
      merchant:   m.merchant_name,
      api_calls:  Number(m.call_count),
      volume:     `$${Number(m.volume).toFixed(6)}`,
      earned:     `$${Number(m.earned).toFixed(6)}`
    })),

    verified_at
  }
}

// ── Nightly scheduler ────────────────────────────────────────────────────────
export const startAuditScheduler = () => {
  const INTERVAL = 24 * 60 * 60 * 1000 // 24 hours

  setInterval(async () => {
    try {
      console.log('Running scheduled audit...')
      const result = await runAudit()
      console.log(`Audit complete: ${result.status} — ${result.total_entries} entries`)
    } catch (err) {
      console.error('Scheduled audit failed:', err)
    }
  }, INTERVAL)

  console.log('Audit scheduler started — runs every 24 hours')
}