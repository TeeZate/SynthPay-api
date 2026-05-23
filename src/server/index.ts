import Fastify from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import dotenv from 'dotenv'
import { resolve } from 'path'
import { readFileSync } from 'fs'
import { testConnection } from '../db/index'
import { runMigrations } from '../db/migrations'
import { runSeed } from '../db/seed'
import { merchantRoutes } from './routes/merchants'
import { adminRoutes } from './routes/admin'
import { userRoutes } from './routes/users'
import { authRoutes } from './routes/auth'
import { walletRoutes } from './routes/wallet'
import { validateEnv } from './config'
import rawBody from 'fastify-raw-body'
import { payoutRoutes } from './routes/payouts'
import { runAudit } from './audit'
import { auditRoutes } from './routes/audit'
import { recordRequest, recordActiveUser, recordPageView } from './traffic'

dotenv.config({ path: resolve(process.cwd(), '.env') })

validateEnv()

const server = Fastify({
  logger: true,
  bodyLimit: 1048576
})

const start = async () => {
  try {

    await server.register(helmet)

    await server.register(cors, {
      origin: [
        'https://synthpay-dashboard.vercel.app',
        'https://synthpay-wallet.vercel.app',
        'https://synthpay-landing.vercel.app',
        'https://wallet.synthpay.tech',
        'https://account.synthpay.tech',
        'https://dashboard.synthpay.tech',
        'https://www.synthpay.tech',
        'https://synthpay.tech',
        'https://trustledger.up.railway.app',
        'http://localhost:5174',
        'http://localhost:5175',
        'http://localhost:5176',
      ]
    })

    await server.register(rateLimit, {
      global: true,
      max: 100,
      timeWindow: 60000,
      addHeaders: {
        'x-ratelimit-limit': true,
        'x-ratelimit-remaining': true,
        'x-ratelimit-reset': true,
        'retry-after': true
      },
      errorResponseBuilder: (_request, context) => ({
        statusCode: 429,
        error: 'Too Many Requests',
        message: `Rate limit exceeded. Try again in ${context.after}.`,
        retryAfter: context.after
      })
    })

    await server.register(rawBody, {
      field: 'rawBody',
      global: false,
      encoding: 'utf8',
      runFirst: true
    })

    // Run migrations + seed on every startup (both are idempotent)
    await runMigrations()
    await runSeed()

    // Favicon
    server.get('/favicon.svg', async (_request, reply) => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
  <rect width="32" height="32" rx="6" fill="#FFFFFF"/>
  <text x="14" y="24" font-family="Arial Black, Arial, sans-serif" font-weight="900" font-size="22" fill="#0D0C0A" text-anchor="middle">S</text>
  <circle cx="25" cy="7" r="4" fill="#F59B00"/>
</svg>`
      return reply.type('image/svg+xml').send(svg)
    })

    // Monitor page
    server.get('/monitor.html', async (_request, reply) => {
      const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SynthPay · System Monitor</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<style>
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;600;700&family=DM+Mono:wght@400;500&display=swap');
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#0A0906;color:#F0EEE8;font-family:'DM Sans',system-ui,sans-serif;padding:32px 24px;min-height:100vh}
  h1{font-family:'DM Mono',monospace;font-size:11px;letter-spacing:3px;color:#7A7670;margin-bottom:24px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin-bottom:32px}
  .card{background:#111009;border:1px solid #222018;border-radius:12px;padding:20px}
  .card-label{font-family:'DM Mono',monospace;font-size:9px;letter-spacing:2px;color:#7A7670;margin-bottom:8px}
  .card-value{font-size:22px;font-weight:700;color:#F0EEE8}
  .card-value.green{color:#10b981}
  .card-value.amber{color:#F0A500}
  .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:middle}
  .dot.green{background:#10b981} .dot.red{background:#ef4444}
  a{color:#F0A500;font-family:'DM Mono',monospace;font-size:11px;text-decoration:none}
</style>
</head>
<body>
<h1>SYNTHPAY · SYSTEM MONITOR</h1>
<div class="grid" id="grid">
  <div class="card"><div class="card-label">API STATUS</div><div class="card-value green" id="api-status">Checking...</div></div>
  <div class="card"><div class="card-label">DATABASE</div><div class="card-value" id="db-status">Checking...</div></div>
  <div class="card"><div class="card-label">TIMESTAMP</div><div class="card-value amber" id="timestamp" style="font-size:13px;font-family:monospace">—</div></div>
</div>
<p><a href="/">← Back</a> &nbsp;&nbsp; <a href="/health">Raw health JSON</a></p>
<script>
  async function check() {
    try {
      const r = await fetch('/health')
      const d = await r.json()
      document.getElementById('api-status').innerHTML = '<span class="dot green"></span>Operational'
      const db = document.getElementById('db-status')
      db.innerHTML = d.database === 'connected'
        ? '<span class="dot green"></span>Connected'
        : '<span class="dot red"></span>Disconnected'
      db.className = 'card-value ' + (d.database === 'connected' ? 'green' : '')
      document.getElementById('timestamp').textContent = new Date(d.timestamp).toLocaleString()
    } catch {
      document.getElementById('api-status').innerHTML = '<span class="dot red"></span>Unreachable'
    }
  }
  check()
  setInterval(check, 30000)
</script>
</body>
</html>`
      return reply.type('text/html').send(html)
    })

    // Root — branded status page
    server.get('/', async (_request, reply) => {
      const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>TrustLedger — API Billing Infrastructure</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<style>
  body { margin: 0; background: #0A0906; color: #F0EEE8; font-family: 'DM Sans', system-ui, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  .wrap { text-align: center; }
  .logo { font-size: 48px; font-weight: 900; color: #F0A500; letter-spacing: -2px; margin-bottom: 8px; }
  .sub { font-size: 13px; color: #7A7670; letter-spacing: 3px; font-family: monospace; margin-bottom: 32px; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #10b981; margin-right: 8px; vertical-align: middle; }
  .status { font-size: 13px; color: #C8C4BC; }
  a { color: #F0A500; text-decoration: none; font-size: 13px; margin: 0 12px; }
</style>
</head>
<body>
<div class="wrap">
  <div class="logo">T</div>
  <div class="sub">TRUSTLEDGER · API BILLING INFRASTRUCTURE</div>
  <p class="status"><span class="dot"></span>All systems operational</p>
  <p style="margin-top: 24px;">
    <a href="/health">Health</a>
    <a href="https://www.synthpay.tech">SynthPay</a>
    <a href="https://dashboard.synthpay.tech">Dashboard</a>
  </p>
</div>
</body>
</html>`
      return reply.type('text/html').send(html)
    })

    // Health check
    server.get('/health', async () => {
      const dbAlive = await testConnection()
      return {
        status:    'alive',
        service:   'SynthPay',
        database:  dbAlive ? 'connected' : 'disconnected',
        timestamp: new Date().toISOString()
      }
    })

    // Test page — development only
    if (process.env.NODE_ENV === 'development') {
      server.get('/test', async (request, reply) => {
        const html = readFileSync(
          resolve(process.cwd(), 'passkey-test.html'),
          'utf-8'
        )
        return reply.type('text/html').send(html)
      })
    }

    // ── Per-route rate limits — stricter on auth/registration ─────────────────
    // These override the global 100 req/min for sensitive endpoints.

    // Registration: 5 attempts per 10 min per IP — slows credential stuffing
    server.addHook('onRequest', async (request, reply) => {
      const authRoutes = [
        '/auth/register/begin',
        '/auth/register/complete',
        '/auth/login/begin',
        '/auth/email/request',
      ]
      if (authRoutes.includes(request.url)) {
        const key = `auth_${request.ip}`
        const store = (server as any)._authRateStore || ((server as any)._authRateStore = new Map<string, { count: number; reset: number }>())
        const now   = Date.now()
        const entry = store.get(key) || { count: 0, reset: now + 10 * 60 * 1000 }

        if (now > entry.reset) {
          entry.count = 0
          entry.reset = now + 10 * 60 * 1000
        }
        entry.count++
        store.set(key, entry)

        reply.header('X-Auth-RateLimit-Limit',     '5')
        reply.header('X-Auth-RateLimit-Remaining', String(Math.max(0, 5 - entry.count)))
        reply.header('X-Auth-RateLimit-Reset',     String(Math.ceil(entry.reset / 1000)))

        if (entry.count > 5) {
          return reply.status(429).send({
            statusCode: 429,
            error:      'Too Many Requests',
            message:    'Too many auth attempts. Please wait 10 minutes.',
          })
        }
      }
    })

    // ── Traffic monitoring hook ───────────────────────────────────────────────
    server.addHook('onResponse', (request, reply, done) => {
      const latency = Math.round(reply.elapsedTime ?? 0)
      recordRequest(request.method, request.url, reply.statusCode, latency)
      const userId = (request as any).user_id
      if (userId) recordActiveUser(userId)
      done()
    })

    // Page view tracker — called by frontend pages on load (no auth, no PII)
    server.post('/metrics/pageview', async (request, reply) => {
      const { page } = request.body as { page?: string }
      if (page) recordPageView(page)
      return reply.status(204).send()
    })

    server.register(merchantRoutes)
    server.register(userRoutes)
    server.register(authRoutes)
    server.register(walletRoutes)
    server.register(payoutRoutes)
    server.register(auditRoutes)
    server.register(adminRoutes)

    // Nightly audit — runs at midnight every day
    const scheduleNightlyAudit = () => {
      const now     = new Date()
      const midnight = new Date()
      midnight.setHours(24, 0, 0, 0)
      const msUntilMidnight = midnight.getTime() - now.getTime()

      setTimeout(async () => {
        console.log('🔍 Running nightly audit...')
        await runAudit()
        scheduleNightlyAudit()  // Schedule next night
      }, msUntilMidnight)

      console.log(`⏰ Next audit scheduled in ${Math.round(msUntilMidnight / 1000 / 60)} minutes`)
    }

    scheduleNightlyAudit()

    await server.listen({
      port: Number(process.env.PORT) || 3000,
      host: '0.0.0.0'
    })

    console.log('🚀 SynthPay server running on port 3000')

  } catch (err) {
    server.log.error(err)
    process.exit(1)
  }
}

start()