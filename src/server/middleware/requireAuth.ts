import { FastifyRequest, FastifyReply } from 'fastify'
import jwt from 'jsonwebtoken'

const JWT_SECRET = process.env.JWT_SECRET || 'changeme'

export const requireAuth = async (
  request: FastifyRequest,
  reply: FastifyReply
) => {
  const authHeader = request.headers.authorization

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return reply.status(401).send({
      error: 'Unauthorised',
      message: 'Include Authorization: Bearer <token> header'
    })
  }

  const token = authHeader.split(' ')[1]

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { user_id: string }
    ;(request as any).user_id = decoded.user_id
  } catch {
    return reply.status(401).send({
      error: 'Unauthorised',
      message: 'Token invalid or expired'
    })
  }
}