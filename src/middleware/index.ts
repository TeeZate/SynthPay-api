import { db } from '../db/index'
import { atomicDeduct } from '../server/ledger'

interface TrustLedgerOptions {
  merchant_id:  string
  api_key:      string
  default_price?: number
}

interface FastifyRequest {
  headers: Record<string, string | undefined>
  url:     string
}

interface FastifyReply {
  status: (code: number) => FastifyReply
  send:   (payload: unknown) => void
}

// Verify merchant API key and get merchant
const getMerchant = async (api_key: string) => {
  return await db('merchants')
    .where({ api_key, active: true })
    .first()
}

// Get endpoint price for this route
const getEndpointPrice = async (
  merchant_id: string,
  path: string
): Promise<{ id: string; price: number } | null> => {

  // Try exact match first
  let endpoint = await db('endpoints')
    .where({ merchant_id, path, active: true })
    .first()

  // Try prefix match — /v1/chat matches /v1/chat/completions
  if (!endpoint) {
    const endpoints = await db('endpoints')
      .where({ merchant_id, active: true })
    
    endpoint = endpoints.find((e: any) => 
      path.startsWith(e.path)
    )
  }

  if (!endpoint) return null

  return {
    id:    endpoint.id,
    price: Number(endpoint.price)
  }
}

// Core middleware function — works with any Node.js framework
export const trustledger = (options: TrustLedgerOptions) => {
  return async (
    req: FastifyRequest,
    reply: FastifyReply,
    next: () => void
  ) => {
    const { merchant_id, api_key, default_price } = options

    // Get user passport token from header
    const user_id = req.headers['x-trustledger-user'] as string

    if (!user_id) {
      reply.status(402).send({
        error:    'Payment required',
        message:  'Include x-trustledger-user header with your user ID',
        topup_url: 'https://trustledger.io/wallet'
      })
      return
    }

    // Verify merchant
    const merchant = await getMerchant(api_key)
    if (!merchant) {
      // Fail open — if our system is broken, don't block merchant's users
      console.error('TrustLedger: Invalid merchant API key')
      next()
      return
    }

    // Get price for this endpoint
    const endpoint = await getEndpointPrice(merchant_id, req.url)

    if (!endpoint && !default_price) {
      // No price configured — pass through free
      next()
      return
    }

    const price = endpoint?.price || default_price || 0

    if (price === 0) {
      next()
      return
    }

    // Verify user exists
    const user = await db('users')
      .where({ id: user_id })
      .first()

    if (!user) {
      reply.status(402).send({
        error:    'Invalid user',
        message:  'Create a TrustLedger wallet at trustledger.io',
        topup_url: 'https://trustledger.io/wallet'
      })
      return
    }

    // Run atomic payment
    const result = await atomicDeduct({
      user_id,
      merchant_id,
      endpoint_id: endpoint?.id || '',
      amount:      price
    })

    if (!result.success) {
      reply.status(402).send({
        error:         'Insufficient balance',
        message:       result.error,
        balance_after: result.balance_after,
        topup_url:    'https://trustledger.io/wallet'
      })
      return
    }

    // Payment successful — let the request through
    next()
  }
}

// Express compatible version
export const trustledgerExpress = (options: TrustLedgerOptions) => {
  const middleware = trustledger(options)
  return async (req: any, res: any, next: any) => {
    const reply = {
      status: (code: number) => ({
        send: (payload: unknown) => res.status(code).json(payload)
      }),
      send: (payload: unknown) => res.json(payload)
    }
    await middleware(req, reply as any, next)
  }
}

// Fastify compatible version
export const trustledgerFastify = (options: TrustLedgerOptions) => {
  const middleware = trustledger(options)
  return async (req: any, reply: any) => {
    await middleware(req, reply, () => {})
  }
}