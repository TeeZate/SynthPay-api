import { db } from './index'
import { randomBytes } from 'crypto'

// ─── Demo merchants — one per marketplace template ────────────────────────────
// Names/descriptions are chosen to trigger the correct detectTemplate() regex
// in the wallet Marketplace.tsx frontend.
const DEMO_MERCHANTS = [
  {
    name: 'SynthFlix',
    endpoints: [
      {
        path:         '/stream/access',
        price:        0.05,
        service_name: 'SynthFlix',
        description:  'Per-access streaming — films, documentaries and series on demand. Watch what you want, pay only for what you watch.',
        category:     'Media',
      },
    ],
  },
  {
    name: 'ArenaPass',
    endpoints: [
      {
        path:         '/sports/access',
        price:        0.05,
        service_name: 'ArenaPass',
        description:  'Live sport and replay coverage — football, basketball, cricket and more. Pay per match or highlight reel.',
        category:     'Media',
      },
    ],
  },
  {
    name: 'The Daily Gazette',
    endpoints: [
      {
        path:         '/news/article',
        price:        0.002,
        service_name: 'The Daily Gazette',
        description:  'Premium news and press coverage. Pay per article — no subscription, no ads.',
        category:     'News',
      },
    ],
  },
  {
    name: 'SynthSound Music',
    endpoints: [
      {
        path:         '/music/stream',
        price:        0.01,
        service_name: 'SynthSound Music',
        description:  'Stream any music track or audio playlist on demand. Pay per listen.',
        category:     'Music',
      },
    ],
  },
  {
    name: 'DevAcademy',
    endpoints: [
      {
        path:         '/course/lesson',
        price:        0.01,
        service_name: 'DevAcademy',
        description:  'Programming and tech courses — lessons, tutorials and hands-on study projects.',
        category:     'Education',
      },
    ],
  },
  {
    name: 'NeuralAPI',
    endpoints: [
      {
        path:         '/ai/query',
        price:        0.001,
        service_name: 'NeuralAPI',
        description:  'AI-powered text tools: summarise, translate, explain code, generate copy. Pay per AI query.',
        category:     'AI',
      },
    ],
  },
  {
    name: 'MarketPulse',
    endpoints: [
      {
        path:         '/market/session',
        price:        0.002,
        service_name: 'MarketPulse',
        description:  'Real-time finance and market data — stocks, crypto, forex prices and live trading signals.',
        category:     'Finance',
      },
    ],
  },
  {
    name: 'CalmSpace',
    endpoints: [
      {
        path:         '/wellness/session',
        price:        0.005,
        service_name: 'CalmSpace',
        description:  'Guided breathing, meditation and mindfulness wellness sessions. Pay per session.',
        category:     'Health',
      },
    ],
  },
]

export const runSeed = async () => {
  const existing = await db('merchants')
    .whereIn('name', DEMO_MERCHANTS.map(m => m.name))
    .select('name')

  const existingNames = new Set(existing.map((r: any) => r.name))
  const toSeed = DEMO_MERCHANTS.filter(m => !existingNames.has(m.name))

  if (toSeed.length === 0) {
    console.log('✅ Demo merchants already seeded — skipping')
    return
  }

  for (const demo of toSeed) {
    const api_key = `tl_demo_${randomBytes(16).toString('hex')}`

    const [merchant] = await db('merchants')
      .insert({
        name:         demo.name,
        api_key,
        balance:      0,
        total_earned: 0,
        active:       true,
      })
      .returning(['id'])

    for (const ep of demo.endpoints) {
      await db('endpoints').insert({
        merchant_id:  merchant.id,
        path:         ep.path,
        price:        ep.price,
        active:       true,
        service_name: ep.service_name,
        description:  ep.description,
        category:     ep.category,
      })
    }

    console.log(`✅ Seeded demo merchant: ${demo.name} ($${demo.endpoints[0].price} per access)`)
  }

  console.log(`✅ Demo seed complete — ${toSeed.length} merchant(s) added`)
}
