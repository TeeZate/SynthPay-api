import { FastifyInstance } from 'fastify'
import { timingSafeEqual } from 'crypto'
import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server'
import { db } from '../../db/index'
import { getTrafficStats } from '../traffic'

const ADMIN_SECRET = process.env.ADMIN_SECRET || ''
const JWT_SECRET   = process.env.JWT_SECRET || 'changeme'
const ADMIN_RP_ID  = process.env.ADMIN_WEBAUTHN_RPID   || 'trustledger.up.railway.app'
const ADMIN_ORIGIN = process.env.ADMIN_WEBAUTHN_ORIGIN || 'https://trustledger.up.railway.app'
const ADMIN_RP_NAME = 'SynthPay Admin'
const SECRET_HASH_KEY = 'admin_secret_hash'

// Validate the shared admin secret. Once a secret has been rotated in-app, the
// bcrypt hash in app_settings is authoritative and the env ADMIN_SECRET (the
// original committed/guessable bootstrap value) no longer works. Until then the
// env value is accepted via a constant-time compare so the dashboard is reachable.
async function secretValid(secret: string): Promise<boolean> {
  if (!secret) return false

  const row = await db('app_settings').where({ key: SECRET_HASH_KEY }).first()
  if (row) return bcrypt.compare(secret, row.value)

  const a = Buffer.from(secret)
  const b = Buffer.from(ADMIN_SECRET)
  return !!ADMIN_SECRET && a.length === b.length && timingSafeEqual(a, b)
}

// ── Admin auth middleware ─────────────────────────────────────────────────────
// Accepts EITHER a valid admin passkey JWT (Authorization: Bearer) OR the
// shared x-admin-secret header (break-glass / passkey enrollment bootstrap).
async function requireAdmin(request: any, reply: any) {
  const authHeader = (request.headers['authorization'] as string) || ''
  if (authHeader.startsWith('Bearer ')) {
    try {
      const decoded = jwt.verify(authHeader.slice(7), JWT_SECRET) as { admin?: boolean }
      if (decoded.admin === true) { request.adminVia = 'passkey'; return }
    } catch { /* fall through to secret */ }
  }

  const secret = (request.headers['x-admin-secret'] as string) || ''
  if (await secretValid(secret)) { request.adminVia = 'secret'; return }

  return reply.status(401).send({ error: 'Unauthorized' })
}

export const adminRoutes = async (server: FastifyInstance) => {

  // ── PASSKEY AUTH ──────────────────────────────────────────────────────────

  // Enroll a new admin passkey. Bootstrap-gated by the shared secret so only
  // someone already holding x-admin-secret can register a device.
  server.post('/admin/auth/register/begin', { preHandler: requireAdmin }, async (request, reply) => {
    await db('challenges').where('expires_at', '<', new Date()).delete()

    const options = await generateRegistrationOptions({
      rpName:          ADMIN_RP_NAME,
      rpID:            ADMIN_RP_ID,
      userID:          Buffer.from('admin'),
      userName:        'admin@synthpay',
      userDisplayName: 'SynthPay Admin',
      attestationType: 'none',
      authenticatorSelection: {
        userVerification: 'required',
        residentKey:      'required',
      },
      supportedAlgorithmIDs: [-7, -257],
    })

    await db('challenges').insert({
      challenge:  options.challenge,
      type:       'admin_registration',
      user_id:    null,
      expires_at: new Date(Date.now() + 5 * 60 * 1000),
    })

    return reply.send({ options })
  })

  server.post('/admin/auth/register/complete', { preHandler: requireAdmin }, async (request, reply) => {
    const { credential, label } = request.body as { credential: any; label?: string }
    if (!credential) return reply.status(400).send({ error: 'credential required' })

    const stored = await db('challenges')
      .where({ type: 'admin_registration' })
      .where('expires_at', '>', new Date())
      .orderBy('created_at', 'desc')
      .first()
    if (!stored) return reply.status(400).send({ error: 'Challenge expired or not found' })

    let verification: any
    try {
      verification = await verifyRegistrationResponse({
        response:                credential,
        expectedChallenge:       stored.challenge,
        expectedOrigin:          ADMIN_ORIGIN,
        expectedRPID:            ADMIN_RP_ID,
        requireUserVerification: true,
      })
    } catch (err: any) {
      return reply.status(400).send({ error: err.message || 'Verification failed' })
    }

    if (!verification?.verified || !verification.registrationInfo) {
      return reply.status(400).send({ error: 'Verification failed' })
    }

    const { credential: cred } = verification.registrationInfo

    await db('admin_passkeys').insert({
      credential_id: cred.id,
      public_key:    Buffer.from(cred.publicKey).toString('base64'),
      counter:       cred.counter,
      label:         label || null,
      device_type:   verification.registrationInfo.credentialDeviceType || 'unknown',
    })

    await db('challenges').where({ challenge: stored.challenge }).delete()

    return reply.status(201).send({ message: 'Admin passkey enrolled' })
  })

  server.post('/admin/auth/login/begin', async (request, reply) => {
    await db('challenges').where('expires_at', '<', new Date()).delete()

    const options = await generateAuthenticationOptions({
      rpID:             ADMIN_RP_ID,
      userVerification: 'required',
    })

    await db('challenges').insert({
      challenge:  options.challenge,
      type:       'admin_authentication',
      user_id:    null,
      expires_at: new Date(Date.now() + 5 * 60 * 1000),
    })

    return reply.send({ options })
  })

  server.post('/admin/auth/login/complete', async (request, reply) => {
    const { credential } = request.body as { credential: any }
    if (!credential) return reply.status(400).send({ error: 'credential required' })

    const stored = await db('challenges')
      .where({ type: 'admin_authentication' })
      .where('expires_at', '>', new Date())
      .orderBy('created_at', 'desc')
      .first()
    if (!stored) return reply.status(400).send({ error: 'Challenge expired or not found' })

    let passkey = await db('admin_passkeys').where({ credential_id: credential.id }).first()
    if (!passkey) {
      const altId = Buffer.from(credential.id, 'base64url').toString('base64url')
      passkey = await db('admin_passkeys').where({ credential_id: altId }).first()
    }
    if (!passkey) return reply.status(404).send({ error: 'Passkey not found' })

    let verification: any
    try {
      verification = await verifyAuthenticationResponse({
        response:          credential,
        expectedChallenge: stored.challenge,
        expectedOrigin:    ADMIN_ORIGIN,
        expectedRPID:      ADMIN_RP_ID,
        credential: {
          id:        passkey.credential_id,
          publicKey: new Uint8Array(Buffer.from(passkey.public_key, 'base64')),
          counter:   passkey.counter,
        },
        requireUserVerification: true,
      })
    } catch (err: any) {
      return reply.status(401).send({ error: 'Authentication failed' })
    }

    if (!verification?.verified) return reply.status(401).send({ error: 'Authentication failed' })

    await db('admin_passkeys')
      .where({ id: passkey.id })
      .update({ counter: verification.authenticationInfo.newCounter, last_used_at: new Date() })

    await db('challenges').where({ challenge: stored.challenge }).delete()

    const token = jwt.sign({ admin: true }, JWT_SECRET, { expiresIn: '8h' })

    return reply.send({ message: 'Login successful', token })
  })

  // Whether any admin passkey is enrolled (drives the login UI).
  server.get('/admin/auth/status', async (request, reply) => {
    const row = await db('admin_passkeys').count('id as n').first()
    return reply.send({ enrolled: Number(row?.n || 0) > 0 })
  })

  // Rotate the break-glass admin secret. Requires re-entering the current
  // secret (proof of knowledge) even when authenticated via passkey JWT.
  server.post('/admin/secret/rotate', { preHandler: requireAdmin }, async (request: any, reply) => {
    const { current_secret, new_secret } = request.body as {
      current_secret?: string
      new_secret?:     string
    }

    if (!new_secret) {
      return reply.status(400).send({ error: 'new_secret required' })
    }

    // Passkey-authenticated admins can reset the secret without knowing the old
    // one (the passkey is sufficient proof of identity). Secret-authenticated
    // callers must still re-enter the current secret as proof of knowledge.
    if (request.adminVia !== 'passkey') {
      if (!current_secret) {
        return reply.status(400).send({ error: 'current_secret required' })
      }
      if (!(await secretValid(current_secret))) {
        return reply.status(401).send({ error: 'Current secret is incorrect' })
      }
    }

    if (new_secret.length < 16) {
      return reply.status(400).send({ error: 'New secret must be at least 16 characters' })
    }
    if (current_secret && new_secret === current_secret) {
      return reply.status(400).send({ error: 'New secret must differ from the current one' })
    }

    const hash = await bcrypt.hash(new_secret, 12)
    const existing = await db('app_settings').where({ key: SECRET_HASH_KEY }).first()
    if (existing) {
      await db('app_settings').where({ key: SECRET_HASH_KEY }).update({ value: hash, updated_at: new Date() })
    } else {
      await db('app_settings').insert({ key: SECRET_HASH_KEY, value: hash })
    }

    return reply.send({ message: 'Admin secret rotated' })
  })

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

  // ── Comprehensive monitor (for the ops dashboard) ─────────────────────────
  server.get('/admin/monitor', { preHandler: requireAdmin }, async (request, reply) => {
    const now  = new Date()
    const ago1h  = new Date(now.getTime() - 60 * 60 * 1000)
    const ago24h = new Date(now.getTime() - 24 * 60 * 60 * 1000)
    const ago7d  = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)

    // ── Helper: HTTP probe a URL, return { ok, latency_ms, status } ──────────
    const probe = async (url: string) => {
      const t0 = Date.now()
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
        return { ok: res.ok, status: res.status, latency_ms: Date.now() - t0 }
      } catch {
        return { ok: false, status: 0, latency_ms: Date.now() - t0 }
      }
    }

    // ── DB latency ────────────────────────────────────────────────────────────
    const dbT0 = Date.now()
    await db.raw('SELECT 1')
    const dbLatency = Date.now() - dbT0

    // ── All DB queries in parallel ────────────────────────────────────────────
    const [
      userTotal,
      userWithEmail,
      userWithBalance,
      usersActive24h,
      newUsers24h,
      newUsers7d,

      topupPending,
      topupPendingStuck,  // pending > 1h (truly stuck, not just in-flight)
      topupFailed24h,
      topupCompleted24h,
      topupFailed7d,
      topupFailedRecent,
      topupCompleted7d,
      topupVolume24h,

      ledgerTotal,
      ledger24h,
      ledger1h,
      lastTx,
      ledger7d,

      merchantTotal,
      merchantActive,
      merchantsWithBalance,
      topMerchants,

      challengesAll,
      passkeysNew24h,

      auditLatest,

      usersNegativeBalance,
      highBalanceUsers,
      recentUsers,
    ] = await Promise.all([
      db('users').count('id as n').first(),
      db('users').whereNotNull('email').count('id as n').first(),
      db('users').where('balance', '>', 0).count('id as n').first(),
      db('ledger').where('created_at', '>=', ago24h).countDistinct('user_id as n').first(),
      db('users').where('created_at', '>=', ago24h).count('id as n').first(),
      db('users').where('created_at', '>=', ago7d).count('id as n').first(),

      db('topups').where({ status: 'pending' }).count('id as n').first(),
      db('topups').where({ status: 'pending' }).where('created_at', '<', ago1h).count('id as n').first(),
      db('topups').where({ status: 'failed' }).where('created_at', '>=', ago24h).count('id as n').first(),
      db('topups').where({ status: 'completed' }).where('created_at', '>=', ago24h).count('id as n').first(),
      db('topups').where({ status: 'failed' }).where('created_at', '>=', ago7d).count('id as n').first(),
      db('topups').where({ status: 'failed' }).orderBy('created_at', 'desc').limit(5)
        .select('user_id', 'amount', 'status', 'created_at', 'stripe_payment_id'),
      db('topups').where({ status: 'completed' }).where('created_at', '>=', ago7d).count('id as n').first(),
      db('topups').where({ status: 'completed' }).where('created_at', '>=', ago24h)
        .sum('amount as total').first(),

      db('ledger').count('id as n').first(),
      db('ledger').where('created_at', '>=', ago24h)
        .select(db.raw('COUNT(*) as n'), db.raw('SUM(amount) as vol'), db.raw('SUM(platform_fee) as fees')).first(),
      db('ledger').where('created_at', '>=', ago1h)
        .select(db.raw('COUNT(*) as n'), db.raw('SUM(amount) as vol')).first(),
      db('ledger').orderBy('created_at', 'desc').first(),
      db('ledger').where('created_at', '>=', ago7d)
        .select(db.raw('COUNT(*) as n'), db.raw('SUM(amount) as vol')).first(),

      db('merchants').count('id as n').first(),
      db('merchants').where({ active: true }).count('id as n').first(),
      db('merchants').where('balance', '>', 0).count('id as n').first(),
      db('merchants as m')
        .leftJoin(db('ledger').where('created_at', '>=', ago24h).groupBy('merchant_id')
          .select('merchant_id', db.raw('COUNT(*) as tx'), db.raw('SUM(amount) as vol')).as('l'),
          'l.merchant_id', 'm.id')
        .where({ 'm.active': true })
        .select('m.id', 'm.name', 'm.balance', 'm.total_earned',
          db.raw('COALESCE(l.tx, 0) as tx_24h'),
          db.raw('COALESCE(l.vol, 0) as vol_24h'))
        .orderBy('m.total_earned', 'desc').limit(10),

      db('challenges').where('expires_at', '>', now).select('type', 'created_at'),
      db('passkeys').where('created_at', '>=', ago24h).count('id as n').first(),

      db('audit_log').orderBy('run_at', 'desc').first(),

      db('users').where('balance', '<', 0).select('id', 'balance', 'updated_at').limit(10),
      db('users').where('balance', '>', 10).orderBy('balance', 'desc').limit(5)
        .select('id', 'balance', 'updated_at'),
      db('users').orderBy('created_at', 'desc').limit(5)
        .select('id', 'balance', 'created_at', 'email'),
    ])

    // ── Frontend probes (parallel) ────────────────────────────────────────────
    const [walletProbe, walletLegacyProbe, dashProbe, landingProbe, tlLandingProbe] = await Promise.all([
      probe('https://account.synthpay.tech'),
      probe('https://wallet.synthpay.tech'),
      probe('https://dashboard.synthpay.tech'),
      probe('https://www.synthpay.tech'),
      probe('https://trustledger.up.railway.app'),
    ])

    // ── Infer issues / alerts ─────────────────────────────────────────────────
    const alerts: { level: 'critical' | 'warning' | 'info'; code: string; message: string }[] = []

    if (!walletProbe.ok)
      alerts.push({ level: 'critical', code: 'ACCOUNT_DOWN', message: `account.synthpay.tech is unreachable (HTTP ${walletProbe.status})` })
    if (!walletLegacyProbe.ok)
      alerts.push({ level: 'warning', code: 'WALLET_LEGACY_DOWN', message: `wallet.synthpay.tech (legacy) is unreachable (HTTP ${walletLegacyProbe.status}) — passkey migration flow will be broken` })
    if (!dashProbe.ok)
      alerts.push({ level: 'critical', code: 'DASHBOARD_DOWN', message: `dashboard.synthpay.tech is unreachable (HTTP ${dashProbe.status})` })
    if (!landingProbe.ok)
      alerts.push({ level: 'warning', code: 'LANDING_DOWN', message: `synthpay.tech is unreachable (HTTP ${landingProbe.status})` })
    if (!tlLandingProbe.ok)
      alerts.push({ level: 'warning', code: 'TL_LANDING_DOWN', message: `TrustLedger landing is unreachable (HTTP ${tlLandingProbe.status})` })

    if (Number(topupPendingStuck?.n || 0) > 0)
      alerts.push({ level: 'warning', code: 'TOPUPS_STUCK', message: `${topupPendingStuck?.n} top-up(s) stuck in 'pending' for >1 hour — Stripe webhook may not be firing (${topupPending?.n} pending total)` })
    if (Number(topupFailed24h?.n || 0) > 0)
      alerts.push({ level: 'warning', code: 'TOPUP_FAILURES', message: `${topupFailed24h?.n} failed top-up(s) in the last 24 h — check Stripe dashboard` })

    if ((usersNegativeBalance as any[]).length > 0)
      alerts.push({ level: 'critical', code: 'NEGATIVE_BALANCES', message: `${(usersNegativeBalance as any[]).length} user(s) have negative balance — possible double-spend bug` })

    if (auditLatest?.status === 'FAILED')
      alerts.push({ level: 'critical', code: 'AUDIT_FAILED', message: `Last audit FAILED — ${auditLatest.anomalies} anomaly(s) detected` })
    if (!auditLatest)
      alerts.push({ level: 'info', code: 'NO_AUDIT', message: 'Audit has never been run — POST /audit/run to baseline the chain' })

    const stuckChallenges = (challengesAll as any[]).filter(
      (c: any) => Date.now() - new Date(c.created_at).getTime() > 2 * 60 * 1000
    )
    if (stuckChallenges.length > 3)
      alerts.push({ level: 'warning', code: 'AUTH_CHALLENGES_PILED', message: `${stuckChallenges.length} WebAuthn challenges open >2 min — users may be stuck on the biometric prompt` })

    if (dbLatency > 500)
      alerts.push({ level: 'warning', code: 'DB_SLOW', message: `Database latency is ${dbLatency}ms — above 500ms threshold` })

    // ── Compose response ──────────────────────────────────────────────────────
    return reply.send({
      generated_at: now.toISOString(),
      alerts,

      services: {
        api:            { name: 'TrustLedger API',          url: 'trustledger-production.up.railway.app', ok: true,                     latency_ms: dbLatency,                  note: 'responding (this endpoint)' },
        account:        { name: 'SynthPay Account',         url: 'account.synthpay.tech',                 ok: walletProbe.ok,           latency_ms: walletProbe.latency_ms,       status: walletProbe.status,       note: 'primary domain' },
        wallet_legacy:  { name: 'SynthPay Account (Legacy)',url: 'wallet.synthpay.tech',                  ok: walletLegacyProbe.ok,     latency_ms: walletLegacyProbe.latency_ms, status: walletLegacyProbe.status, note: 'needed for passkey migration flow' },
        dashboard:      { name: 'Merchant Dashboard',       url: 'dashboard.synthpay.tech',               ok: dashProbe.ok,             latency_ms: dashProbe.latency_ms,         status: dashProbe.status },
        landing:        { name: 'SynthPay Landing',         url: 'www.synthpay.tech',                     ok: landingProbe.ok,          latency_ms: landingProbe.latency_ms,      status: landingProbe.status },
        tl_landing:     { name: 'TrustLedger Landing',      url: 'trustledger.up.railway.app',            ok: tlLandingProbe.ok,        latency_ms: tlLandingProbe.latency_ms,    status: tlLandingProbe.status },
        database:       { name: 'PostgreSQL (Railway)',      url: 'postgres.railway.internal:5432',        ok: true,                     latency_ms: dbLatency },
      },

      users: {
        total:          Number(userTotal?.n || 0),
        with_email:     Number(userWithEmail?.n || 0),
        with_balance:   Number(userWithBalance?.n || 0),
        active_24h:     Number(usersActive24h?.n || 0),
        new_24h:        Number(newUsers24h?.n || 0),
        new_7d:         Number(newUsers7d?.n || 0),
        negative_balance: (usersNegativeBalance as any[]).map((u: any) => ({
          id: u.id, balance: Number(u.balance), updated_at: u.updated_at
        })),
        high_balance:   (highBalanceUsers as any[]).map((u: any) => ({
          id: u.id, balance: Number(u.balance)
        })),
        recent:         (recentUsers as any[]).map((u: any) => ({
          id: u.id, balance: Number(u.balance), created_at: u.created_at, has_email: !!u.email
        })),
      },

      auth: {
        new_passkeys_24h:    Number(passkeysNew24h?.n || 0),
        open_challenges:     (challengesAll as any[]).length,
        open_by_type: {
          registration:   (challengesAll as any[]).filter((c: any) => c.type === 'registration').length,
          authentication: (challengesAll as any[]).filter((c: any) => c.type === 'authentication').length,
          migration:      (challengesAll as any[]).filter((c: any) => c.type === 'migration').length,
        },
        stuck_challenges:    stuckChallenges.length,
        webauthn_rpid_old:   process.env.WEBAUTHN_RPID || 'synthpay-wallet.vercel.app',
        webauthn_rpid_new:   process.env.WEBAUTHN_ACCT_RPID || 'account.synthpay.tech',
      },

      payments: {
        topups_pending:      Number(topupPending?.n || 0),
        topups_stuck_1h:     Number(topupPendingStuck?.n || 0),
        topups_failed_24h:   Number(topupFailed24h?.n || 0),
        topups_failed_7d:    Number(topupFailed7d?.n || 0),
        topups_completed_24h: Number(topupCompleted24h?.n || 0),
        topups_completed_7d:  Number(topupCompleted7d?.n || 0),
        volume_deposited_24h: Number((topupVolume24h as any)?.total || 0),
        recent_failures:     (topupFailedRecent as any[]).map((t: any) => ({
          user_id: t.user_id, amount: Number(t.amount),
          created_at: t.created_at, stripe_id: t.stripe_payment_id
        })),
      },

      transactions: {
        total:        Number(ledgerTotal?.n || 0),
        last_hour:    { count: Number((ledger1h as any)?.n || 0), volume: Number((ledger1h as any)?.vol || 0) },
        last_24h:     { count: Number((ledger24h as any)?.n || 0), volume: Number((ledger24h as any)?.vol || 0), fees: Number((ledger24h as any)?.fees || 0) },
        last_7d:      { count: Number((ledger7d as any)?.n || 0), volume: Number((ledger7d as any)?.vol || 0) },
        last_tx_at:   lastTx?.created_at || null,
      },

      merchants: {
        total:             Number(merchantTotal?.n || 0),
        active:            Number(merchantActive?.n || 0),
        with_pending_payout: Number(merchantsWithBalance?.n || 0),
        top_by_earnings:   (topMerchants as any[]).map((m: any) => ({
          id: m.id, name: m.name, total_earned: Number(m.total_earned),
          balance: Number(m.balance), tx_24h: Number(m.tx_24h), vol_24h: Number(m.vol_24h)
        })),
      },

      audit: {
        last_run:     auditLatest?.run_at || null,
        status:       auditLatest?.status || 'never_run',
        total_entries: Number(auditLatest?.total_entries || 0),
        anomaly_count: Number(auditLatest?.anomalies || 0),
        anomaly_details: auditLatest?.anomaly_details || [],
        chain_hash:   auditLatest?.chain_hash ? (auditLatest.chain_hash as string).slice(0, 16) + '…' : null,
      },
    })
  })

  // ── Live traffic stats ────────────────────────────────────────────────────
  server.get('/admin/traffic', { preHandler: requireAdmin }, async (request, reply) => {
    return reply.send(getTrafficStats())
  })

}