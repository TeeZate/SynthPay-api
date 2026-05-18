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