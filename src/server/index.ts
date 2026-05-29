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
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap');
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#0A0906;color:#F0EEE8;font-family:'DM Sans',system-ui,sans-serif;padding:32px 24px;min-height:100vh}
  h1{font-family:'DM Mono',monospace;font-size:11px;letter-spacing:3px;color:#7A7670;margin-bottom:24px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:32px}
  .card{background:#111009;border:1px solid #222018;border-radius:12px;padding:18px}
  .card-label{font-family:'DM Mono',monospace;font-size:9px;letter-spacing:2px;color:#7A7670;margin-bottom:6px}
  .card-value{font-size:20px;font-weight:700;color:#F0EEE8}
  .card-value.green{color:#10b981}.card-value.amber{color:#F0A500}
  .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:middle}
  .dot.green{background:#10b981}.dot.red{background:#ef4444}
  a{color:#F0A500;font-family:'DM Mono',monospace;font-size:11px;text-decoration:none}

  /* Ledger section */
  .section-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;margin-top:32px}
  .section-title{font-family:'DM Mono',monospace;font-size:11px;letter-spacing:3px;color:#7A7670}
  .secret-wrap{display:flex;gap:8px;align-items:center}
  .secret-input{background:#111009;border:1px solid #2a2820;border-radius:6px;padding:6px 10px;color:#F0EEE8;font-family:'DM Mono',monospace;font-size:11px;width:220px;outline:none}
  .secret-input:focus{border-color:#F0A500}
  .btn{background:#F0A500;color:#0A0906;border:none;border-radius:6px;padding:6px 14px;font-family:'DM Mono',monospace;font-size:11px;font-weight:700;cursor:pointer;letter-spacing:1px}
  .btn:hover{background:#ffb800}
  .btn.secondary{background:transparent;border:1px solid #2a2820;color:#7A7670}
  .btn.secondary:hover{border-color:#F0A500;color:#F0A500}

  /* Table */
  .table-wrap{background:#111009;border:1px solid #222018;border-radius:12px;overflow:hidden}
  table{width:100%;border-collapse:collapse}
  thead th{font-family:'DM Mono',monospace;font-size:9px;letter-spacing:2px;color:#7A7670;padding:12px 16px;text-align:left;border-bottom:1px solid #1a1814;white-space:nowrap}
  tbody tr{border-bottom:1px solid #161410;cursor:pointer;transition:background 0.12s}
  tbody tr:last-child{border-bottom:none}
  tbody tr:hover{background:#161410}
  tbody tr.selected{background:#1a1612;border-left:2px solid #F0A500}
  td{padding:11px 16px;font-size:13px;color:#C8C4BC;white-space:nowrap}
  td.mono{font-family:'DM Mono',monospace;font-size:11px}
  td.amount{color:#F0EEE8;font-weight:600}
  td.green{color:#10b981}
  .badge{display:inline-block;padding:2px 8px;border-radius:4px;font-family:'DM Mono',monospace;font-size:10px;letter-spacing:1px}
  .badge.completed{background:#0d2d1e;color:#10b981}
  .badge.pending{background:#2d2200;color:#F0A500}
  .badge.failed{background:#2d0d0d;color:#ef4444}
  .empty{text-align:center;padding:40px;color:#7A7670;font-family:'DM Mono',monospace;font-size:11px}

  /* Drawer */
  .drawer-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:100;opacity:0;pointer-events:none;transition:opacity 0.2s}
  .drawer-overlay.open{opacity:1;pointer-events:all}
  .drawer{position:fixed;top:0;right:0;height:100vh;width:480px;max-width:100vw;background:#0F0E0C;border-left:1px solid #222018;z-index:101;transform:translateX(100%);transition:transform 0.25s cubic-bezier(.4,0,.2,1);overflow-y:auto;padding:28px 28px 48px}
  .drawer.open{transform:translateX(0)}
  .drawer-close{position:absolute;top:20px;right:20px;background:transparent;border:1px solid #2a2820;border-radius:6px;color:#7A7670;padding:4px 10px;cursor:pointer;font-size:18px;line-height:1}
  .drawer-close:hover{border-color:#F0A500;color:#F0A500}
  .drawer h2{font-family:'DM Mono',monospace;font-size:11px;letter-spacing:3px;color:#7A7670;margin-bottom:20px}
  .detail-block{background:#111009;border:1px solid #1a1814;border-radius:10px;padding:16px;margin-bottom:12px}
  .detail-row{display:flex;justify-content:space-between;align-items:flex-start;padding:6px 0;border-bottom:1px solid #161410}
  .detail-row:last-child{border-bottom:none}
  .detail-key{font-family:'DM Mono',monospace;font-size:10px;letter-spacing:1px;color:#7A7670;flex-shrink:0;margin-right:12px}
  .detail-val{font-family:'DM Mono',monospace;font-size:11px;color:#C8C4BC;text-align:right;word-break:break-all}
  .detail-val.highlight{color:#F0EEE8;font-weight:700;font-size:14px}
  .detail-val.green{color:#10b981}
  .detail-val.amber{color:#F0A500}
  .hash-val{font-size:9px;letter-spacing:0;color:#555;word-break:break-all;text-align:right}
  .chain-ok{color:#10b981;font-family:'DM Mono',monospace;font-size:10px}
  .section-sep{font-family:'DM Mono',monospace;font-size:9px;letter-spacing:2px;color:#3a3830;margin:16px 0 8px}

  /* Pagination */
  .pagination{display:flex;align-items:center;gap:8px;margin-top:14px;justify-content:flex-end}
  .page-info{font-family:'DM Mono',monospace;font-size:11px;color:#7A7670}
  .auth-hint{font-family:'DM Mono',monospace;font-size:11px;color:#7A7670;text-align:center;padding:24px}
</style>
</head>
<body>
<h1>SYNTHPAY · SYSTEM MONITOR</h1>

<!-- Status cards -->
<div class="grid" id="grid">
  <div class="card"><div class="card-label">API STATUS</div><div class="card-value green" id="api-status">Checking...</div></div>
  <div class="card"><div class="card-label">DATABASE</div><div class="card-value" id="db-status">Checking...</div></div>
  <div class="card"><div class="card-label">TOTAL TRANSACTIONS</div><div class="card-value amber" id="total-tx">—</div></div>
  <div class="card"><div class="card-label">LAST UPDATED</div><div class="card-value amber" id="timestamp" style="font-size:13px;font-family:monospace">—</div></div>
</div>

<!-- Ledger -->
<div class="section-header">
  <span class="section-title">LEDGER · RECENT TRANSACTIONS</span>
  <div class="secret-wrap">
    <input class="secret-input" type="password" id="secret-input" placeholder="admin secret" />
    <button class="btn" onclick="loadLedger(1)">LOAD</button>
    <button class="btn secondary" id="refresh-btn" onclick="loadLedger(currentPage)" style="display:none">↺ REFRESH</button>
  </div>
</div>
<div class="table-wrap" id="ledger-wrap">
  <div class="auth-hint">Enter the admin secret above to view transactions.</div>
</div>
<div class="pagination" id="pagination" style="display:none">
  <button class="btn secondary" id="prev-btn" onclick="loadLedger(currentPage-1)">← PREV</button>
  <span class="page-info" id="page-info"></span>
  <button class="btn secondary" id="next-btn" onclick="loadLedger(currentPage+1)">NEXT →</button>
</div>

<p style="margin-top:24px"><a href="/">← Back</a> &nbsp;&nbsp; <a href="/health">Raw health JSON</a></p>

<!-- Detail drawer -->
<div class="drawer-overlay" id="overlay" onclick="closeDrawer()"></div>
<div class="drawer" id="drawer">
  <button class="drawer-close" onclick="closeDrawer()">✕</button>
  <h2>TRANSACTION DETAIL</h2>
  <div id="drawer-content"></div>
</div>

<script>
  let currentPage = 1
  let totalPages  = 1
  let selectedId  = null

  // ── Health check ──────────────────────────────────────────────────────────
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

  // ── Ledger loader ─────────────────────────────────────────────────────────
  async function loadLedger(page) {
    const secret = document.getElementById('secret-input').value.trim()
    if (!secret) { alert('Enter the admin secret first.'); return }
    if (page < 1 || page > totalPages) return
    currentPage = page

    document.getElementById('ledger-wrap').innerHTML = '<div class="auth-hint">Loading...</div>'

    try {
      const res = await fetch('/admin/transactions?page=' + page + '&limit=25', {
        headers: { 'x-admin-secret': secret }
      })
      if (res.status === 401) {
        document.getElementById('ledger-wrap').innerHTML = '<div class="auth-hint" style="color:#ef4444">Invalid admin secret.</div>'
        return
      }
      const d = await res.json()
      totalPages = Math.max(1, Math.ceil(d.total / 25))
      document.getElementById('total-tx').textContent = d.total.toLocaleString()
      document.getElementById('refresh-btn').style.display = ''
      renderTable(d.transactions, d.total, page)
      updatePagination(page, totalPages, d.total)
    } catch(e) {
      document.getElementById('ledger-wrap').innerHTML = '<div class="auth-hint" style="color:#ef4444">Failed to load: ' + e.message + '</div>'
    }
  }

  function fmt(val) {
    return '$' + Number(val).toFixed(4)
  }
  function timeAgo(iso) {
    const s = Math.floor((Date.now() - new Date(iso)) / 1000)
    if (s < 60)  return s + 's ago'
    if (s < 3600) return Math.floor(s/60) + 'm ago'
    if (s < 86400) return Math.floor(s/3600) + 'h ago'
    return Math.floor(s/86400) + 'd ago'
  }
  function shortId(id) {
    return id ? id.slice(0,8) + '…' : '—'
  }

  function renderTable(txs, total, page) {
    if (!txs.length) {
      document.getElementById('ledger-wrap').innerHTML = '<div class="empty">No transactions found.</div>'
      return
    }
    let rows = txs.map(tx => {
      const sel = tx.id === selectedId ? ' selected' : ''
      return \`<tr class="tx-row\${sel}" onclick="openDrawer('\${tx.id}')" data-id="\${tx.id}">
        <td class="mono" style="color:#555;font-size:10px">\${shortId(tx.id)}</td>
        <td>\${tx.merchant_name || '—'}</td>
        <td class="mono" style="color:#555;font-size:10px">\${shortId(tx.user_id)}</td>
        <td class="amount">\${fmt(tx.amount)}</td>
        <td class="mono" style="color:#7A7670;font-size:11px">\${fmt(tx.platform_fee)}</td>
        <td class="green mono" style="font-size:11px">\${fmt(tx.merchant_receives)}</td>
        <td><span class="badge \${tx.status}">\${tx.status.toUpperCase()}</span></td>
        <td class="mono" style="color:#555;font-size:10px">\${timeAgo(tx.created_at)}</td>
      </tr>\`
    }).join('')

    document.getElementById('ledger-wrap').innerHTML = \`
      <table>
        <thead><tr>
          <th>TX ID</th><th>MERCHANT</th><th>USER</th>
          <th>AMOUNT</th><th>FEE</th><th>MERCHANT RECV</th>
          <th>STATUS</th><th>WHEN</th>
        </tr></thead>
        <tbody>\${rows}</tbody>
      </table>\`

    // Store tx data for drawer
    window._txCache = {}
    txs.forEach(tx => { window._txCache[tx.id] = tx })
  }

  function updatePagination(page, total, count) {
    const pg = document.getElementById('pagination')
    pg.style.display = 'flex'
    document.getElementById('page-info').textContent = 'PAGE ' + page + ' / ' + total + '  (' + count + ' entries)'
    document.getElementById('prev-btn').disabled = page <= 1
    document.getElementById('next-btn').disabled = page >= total
  }

  // ── Drawer ────────────────────────────────────────────────────────────────
  function openDrawer(id) {
    selectedId = id
    // Highlight selected row
    document.querySelectorAll('.tx-row').forEach(r => {
      r.classList.toggle('selected', r.dataset.id === id)
    })

    const tx = window._txCache && window._txCache[id]
    if (!tx) return

    document.getElementById('drawer-content').innerHTML = \`
      <div class="detail-block">
        <div class="detail-row"><span class="detail-key">MERCHANT</span><span class="detail-val highlight">\${tx.merchant_name || '—'}</span></div>
        <div class="detail-row"><span class="detail-key">AMOUNT</span><span class="detail-val highlight" style="color:#F0A500">\${fmt(tx.amount)}</span></div>
        <div class="detail-row"><span class="detail-key">STATUS</span><span class="detail-val"><span class="badge \${tx.status}">\${tx.status.toUpperCase()}</span></span></div>
        <div class="detail-row"><span class="detail-key">TIMESTAMP</span><span class="detail-val">\${new Date(tx.created_at).toLocaleString()}</span></div>
      </div>

      <div class="section-sep">FINANCIAL BREAKDOWN</div>
      <div class="detail-block">
        <div class="detail-row"><span class="detail-key">CHARGED</span><span class="detail-val highlight">\${fmt(tx.amount)}</span></div>
        <div class="detail-row"><span class="detail-key">PLATFORM FEE</span><span class="detail-val" style="color:#ef4444">\${fmt(tx.platform_fee)}</span></div>
        <div class="detail-row"><span class="detail-key">MERCHANT RECEIVES</span><span class="detail-val green">\${fmt(tx.merchant_receives)}</span></div>
        <div class="detail-row"><span class="detail-key">FEE RATE</span><span class="detail-val">\${(Number(tx.platform_fee) / Number(tx.amount) * 100).toFixed(1)}%</span></div>
      </div>

      <div class="section-sep">IDENTIFIERS</div>
      <div class="detail-block">
        <div class="detail-row"><span class="detail-key">TX ID</span><span class="detail-val" style="font-size:10px">\${tx.id}</span></div>
        <div class="detail-row"><span class="detail-key">USER ID</span><span class="detail-val" style="font-size:10px">\${tx.user_id}</span></div>
        <div class="detail-row"><span class="detail-key">MERCHANT ID</span><span class="detail-val" style="font-size:10px">\${tx.merchant_id}</span></div>
        <div class="detail-row"><span class="detail-key">ENDPOINT ID</span><span class="detail-val" style="font-size:10px">\${tx.endpoint_id}</span></div>
      </div>

      <div class="section-sep">CHAIN INTEGRITY</div>
      <div class="detail-block">
        <div class="detail-row"><span class="detail-key">ENTRY HASH</span><span class="hash-val">\${tx.entry_hash || '—'}</span></div>
        <div class="detail-row"><span class="detail-key">PREV HASH</span><span class="hash-val">\${tx.prev_hash || 'genesis'}</span></div>
        <div class="detail-row"><span class="detail-key">CHAIN</span><span class="detail-val chain-ok">\${tx.entry_hash ? '✓ Signed' : '—'}</span></div>
      </div>\`

    document.getElementById('overlay').classList.add('open')
    document.getElementById('drawer').classList.add('open')
  }

  function closeDrawer() {
    selectedId = null
    document.querySelectorAll('.tx-row').forEach(r => r.classList.remove('selected'))
    document.getElementById('overlay').classList.remove('open')
    document.getElementById('drawer').classList.remove('open')
  }

  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer() })
  document.getElementById('secret-input').addEventListener('keydown', e => { if (e.key === 'Enter') loadLedger(1) })

  // Auto-restore secret from sessionStorage
  const saved = sessionStorage.getItem('sp_admin_secret')
  if (saved) {
    document.getElementById('secret-input').value = saved
    loadLedger(1)
  }
  document.getElementById('secret-input').addEventListener('change', () => {
    sessionStorage.setItem('sp_admin_secret', document.getElementById('secret-input').value)
  })

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