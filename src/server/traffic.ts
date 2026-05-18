// ── In-memory traffic store ───────────────────────────────────────────────────
// GDPR-safe: no IPs stored, no PII. Only counts and timing aggregates.

interface RouteMetric {
  hits_1h:          number
  hits_24h:         number
  errors_1h:        number   // 4xx + 5xx
  errors_24h:       number
  latency_sum_1h:   number
  latency_count_1h: number
}

// route key → metrics
const routeMetrics = new Map<string, RouteMetric>()

// user_id → last-seen timestamp  (never stored to DB)
const activeUsers = new Map<string, number>()

// page name → view counts
const pageViews = new Map<string, { count_1h: number; count_24h: number }>()

// ── Reset 1h counters every hour ─────────────────────────────────────────────
setInterval(() => {
  for (const m of routeMetrics.values()) {
    m.hits_1h          = 0
    m.errors_1h        = 0
    m.latency_sum_1h   = 0
    m.latency_count_1h = 0
  }
  for (const v of pageViews.values()) {
    v.count_1h = 0
  }
  // Prune stale active-user entries
  const cutoff = Date.now() - 5 * 60 * 1000
  for (const [uid, ts] of activeUsers) {
    if (ts < cutoff) activeUsers.delete(uid)
  }
}, 60 * 60 * 1000)

// ── Reset 24h counters every 24 hours ────────────────────────────────────────
setInterval(() => {
  for (const m of routeMetrics.values()) {
    m.hits_24h   = 0
    m.errors_24h = 0
  }
  for (const v of pageViews.values()) {
    v.count_24h = 0
  }
}, 24 * 60 * 60 * 1000)

// ── Public API ────────────────────────────────────────────────────────────────

export const recordRequest = (
  method: string,
  path: string,
  statusCode: number,
  latencyMs: number
) => {
  // Normalise dynamic segments: /users/abc-123 → /users/:id
  const normPath = path
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id')
    .replace(/\?.*$/, '')  // strip query string

  const key = `${method} ${normPath}`

  if (!routeMetrics.has(key)) {
    routeMetrics.set(key, {
      hits_1h: 0, hits_24h: 0,
      errors_1h: 0, errors_24h: 0,
      latency_sum_1h: 0, latency_count_1h: 0
    })
  }

  const m = routeMetrics.get(key)!
  m.hits_1h++
  m.hits_24h++
  m.latency_sum_1h   += latencyMs
  m.latency_count_1h++

  if (statusCode >= 400) {
    m.errors_1h++
    m.errors_24h++
  }
}

export const recordActiveUser = (userId: string) => {
  activeUsers.set(userId, Date.now())
}

export const recordPageView = (page: string) => {
  const key = page.replace(/[^a-z0-9_/-]/gi, '').slice(0, 64) || 'unknown'
  if (!pageViews.has(key)) {
    pageViews.set(key, { count_1h: 0, count_24h: 0 })
  }
  const v = pageViews.get(key)!
  v.count_1h++
  v.count_24h++
}

export const getTrafficStats = () => {
  // Prune stale active users before reporting
  const cutoff = Date.now() - 5 * 60 * 1000
  for (const [uid, ts] of activeUsers) {
    if (ts < cutoff) activeUsers.delete(uid)
  }

  const routes = Array.from(routeMetrics.entries())
    .map(([route, m]) => ({
      route,
      hits_1h:        m.hits_1h,
      hits_24h:       m.hits_24h,
      errors_1h:      m.errors_1h,
      errors_24h:     m.errors_24h,
      error_rate_pct: m.hits_1h > 0
        ? Number(((m.errors_1h / m.hits_1h) * 100).toFixed(1))
        : 0,
      avg_latency_ms: m.latency_count_1h > 0
        ? Math.round(m.latency_sum_1h / m.latency_count_1h)
        : null
    }))
    .sort((a, b) => b.hits_24h - a.hits_24h)

  const pages = Array.from(pageViews.entries())
    .map(([page, v]) => ({ page, views_1h: v.count_1h, views_24h: v.count_24h }))
    .sort((a, b) => b.views_24h - a.views_24h)

  return {
    active_users_5min: activeUsers.size,
    total_routes_tracked: routeMetrics.size,
    routes,
    pages,
  }
}
