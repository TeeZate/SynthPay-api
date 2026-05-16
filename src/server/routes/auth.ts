import { FastifyInstance } from 'fastify'
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server'
import { db } from '../../db/index'
import jwt from 'jsonwebtoken'
import { randomBytes, randomInt } from 'crypto'

const RP_NAME    = 'SynthPay'
const RP_ID      = process.env.WEBAUTHN_RPID     || 'localhost'
const ORIGIN     = process.env.WEBAUTHN_ORIGIN   || 'http://localhost:3000'
const NEW_RPID   = process.env.WEBAUTHN_NEW_RPID || 'wallet.synthpay.tech'
const NEW_ORIGIN = process.env.WEBAUTHN_NEW_ORIGIN || 'https://wallet.synthpay.tech'
const JWT_SECRET = process.env.JWT_SECRET        || 'changeme'
const OTP_EXPIRY = 10 * 60 * 1000              // 10 minutes

// ── Helper: clean expired challenges ─────────────────────────────────────────
const cleanChallenges = async () => {
  await db('challenges').where('expires_at', '<', new Date()).delete()
}

// ── Helper: generate 6-digit OTP ─────────────────────────────────────────────
const generateOTP = (): string => {
  return String(randomInt(100000, 999999))
}

// ── Helper: send OTP email ────────────────────────────────────────────────────
const sendOTPEmail = async (email: string, otp: string, userId: string) => {
  console.log(`
  ==========================================
  SYNTHPAY — Email OTP
  To: ${email}
  User: ${userId.slice(0, 8)}...
  Code: ${otp}
  Expires: ${new Date(Date.now() + OTP_EXPIRY).toISOString()}
  ==========================================
  `)
}

export const authRoutes = async (server: FastifyInstance) => {

  // ── 2.02 REGISTRATION BEGIN ───────────────────────────────────────────────
  // Detects origin header to serve the correct rpId for the calling domain
  server.post('/auth/register/begin', async (request, reply) => {
    await cleanChallenges()

    const origin = (request.headers.origin as string) || ''
    const activeRpId = origin === NEW_ORIGIN ? NEW_RPID : RP_ID

    const userId = randomBytes(16).toString('hex')

    const options = await generateRegistrationOptions({
      rpName:          RP_NAME,
      rpID:            activeRpId,
      userID:          Buffer.from(userId),
      userName:        `user_${userId.slice(0, 8)}`,
      userDisplayName: 'SynthPay User',
      attestationType: 'none',
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification:        'required',
        residentKey:             'preferred',
      },
      supportedAlgorithmIDs: [-7, -257],
    })

    await db('challenges').insert({
      challenge:  options.challenge,
      type:       'registration',
      user_id:    null,
      expires_at: new Date(Date.now() + 5 * 60 * 1000),
    })

    return reply.send({ options, temp_user_id: userId })
  })

  // ── 2.03 REGISTRATION COMPLETE ────────────────────────────────────────────
  server.post('/auth/register/complete', async (request, reply) => {
    const { credential, temp_user_id, display_name } = request.body as {
      credential:    any
      temp_user_id:  string
      display_name?: string
    }

    if (!credential || !temp_user_id) {
      return reply.status(400).send({ error: 'credential and temp_user_id required' })
    }

    const stored = await db('challenges')
      .where({ type: 'registration' })
      .where('expires_at', '>', new Date())
      .orderBy('created_at', 'desc')
      .first()

    if (!stored) {
      return reply.status(400).send({ error: 'Challenge expired or not found' })
    }

    // Try both domains so credentials from either wallet domain verify correctly
    const regAttempts = [
      { origin: NEW_ORIGIN, rpId: NEW_RPID },
      { origin: ORIGIN,     rpId: RP_ID    },
    ]

    let verification: any
    let lastErr: any
    for (const attempt of regAttempts) {
      try {
        verification = await verifyRegistrationResponse({
          response:                credential,
          expectedChallenge:       stored.challenge,
          expectedOrigin:          attempt.origin,
          expectedRPID:            attempt.rpId,
          requireUserVerification: true,
        })
        if (verification.verified) break
      } catch (err: any) {
        lastErr = err
      }
    }

    if (!verification?.verified || !verification.registrationInfo) {
      return reply.status(400).send({ error: lastErr?.message || 'Verification failed' })
    }

    const { credential: cred } = verification.registrationInfo

    const [user] = await db('users')
      .insert({ display_name: display_name || null, balance: 0, reputation: 'new' })
      .returning(['id', 'balance'])

    await db('passkeys').insert({
      user_id:       user.id,
      credential_id: cred.id,
      public_key:    Buffer.from(cred.publicKey).toString('base64'),
      counter:       cred.counter,
      device_type:   verification.registrationInfo.credentialDeviceType || 'unknown',
    })

    await db('challenges').where({ challenge: stored.challenge }).delete()

    const token = jwt.sign({ user_id: user.id }, JWT_SECRET, { expiresIn: '24h' })

    return reply.status(201).send({
      message: 'Wallet created successfully',
      user_id: user.id,
      balance: Number(user.balance),
      token,
    })
  })

  // ── 2.04 LOGIN BEGIN ──────────────────────────────────────────────────────
  // Detects origin header to serve the correct rpId for the calling domain
  server.post('/auth/login/begin', async (request, reply) => {
    await cleanChallenges()

    const origin = (request.headers.origin as string) || ''
    const activeRpId = origin === NEW_ORIGIN ? NEW_RPID : RP_ID

    const options = await generateAuthenticationOptions({
      rpID:             activeRpId,
      userVerification: 'required',
    })

    await db('challenges').insert({
      challenge:  options.challenge,
      type:       'authentication',
      user_id:    null,
      expires_at: new Date(Date.now() + 5 * 60 * 1000),
    })

    return reply.send({ options })
  })

  // ── 2.05 LOGIN COMPLETE ───────────────────────────────────────────────────
  // Tries both old and new rpId/origin pairs so credentials from either domain work
  server.post('/auth/login/complete', async (request, reply) => {
    const { credential } = request.body as { credential: any }

    if (!credential) {
      return reply.status(400).send({ error: 'credential required' })
    }

    const stored = await db('challenges')
      .where({ type: 'authentication' })
      .where('expires_at', '>', new Date())
      .orderBy('created_at', 'desc')
      .first()

    if (!stored) {
      return reply.status(400).send({ error: 'Challenge expired or not found' })
    }

    const credentialId = credential.id
    let passkey = await db('passkeys').where({ credential_id: credentialId }).first()

    if (!passkey) {
      const altId = Buffer.from(credentialId, 'base64url').toString('base64url')
      passkey = await db('passkeys').where({ credential_id: altId }).first()
    }

    if (!passkey) {
      return reply.status(404).send({ error: 'Passkey not found' })
    }

    // Try verifying against old domain first, then new domain
    const attempts = [
      { origin: ORIGIN,     rpId: RP_ID     },
      { origin: NEW_ORIGIN, rpId: NEW_RPID  },
    ]

    let verification: any
    for (const attempt of attempts) {
      try {
        verification = await verifyAuthenticationResponse({
          response:          credential,
          expectedChallenge: stored.challenge,
          expectedOrigin:    attempt.origin,
          expectedRPID:      attempt.rpId,
          credential: {
            id:        passkey.credential_id,
            publicKey: new Uint8Array(Buffer.from(passkey.public_key, 'base64')),
            counter:   passkey.counter,
          },
          requireUserVerification: true,
        })
        if (verification.verified) break
      } catch {
        // try next
      }
    }

    if (!verification?.verified) {
      return reply.status(401).send({ error: 'Authentication failed' })
    }

    await db('passkeys')
      .where({ id: passkey.id })
      .update({ counter: verification.authenticationInfo.newCounter })

    const user = await db('users').where({ id: passkey.user_id }).first()

    await db('challenges').where({ challenge: stored.challenge }).delete()

    const token = jwt.sign({ user_id: user.id }, JWT_SECRET, { expiresIn: '24h' })

    return reply.send({
      message: 'Login successful',
      user_id: user.id,
      balance: Number(user.balance),
      token,
    })
  })

  // ── PASSKEY MIGRATION ─────────────────────────────────────────────────────
  // Allows existing users to add a new passkey bound to wallet.synthpay.tech
  // without losing their account or balance.
  //
  // Flow:
  //   1. User logs in at synthpay-wallet.vercel.app (old domain)
  //   2. Calls /auth/migration-token → gets a 10-min scoped token
  //   3. Redirected to wallet.synthpay.tech/migrate?token=<token>
  //   4. /auth/migrate/begin  → registration options for wallet.synthpay.tech
  //   5. /auth/migrate/complete → new passkey added to existing account
  // ─────────────────────────────────────────────────────────────────────────

  // Step 1: Issue a short-lived migration token (requires current session JWT)
  server.post('/auth/migration-token', async (request, reply) => {
    const auth = request.headers.authorization as string
    if (!auth?.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }

    let payload: any
    try {
      payload = jwt.verify(auth.slice(7), JWT_SECRET)
    } catch {
      return reply.status(401).send({ error: 'Invalid or expired session token' })
    }

    const migrationToken = jwt.sign(
      { user_id: payload.user_id, purpose: 'migration' },
      JWT_SECRET,
      { expiresIn: '10m' }
    )

    return reply.send({ token: migrationToken })
  })

  // Step 2: Begin registration for new domain
  server.post('/auth/migrate/begin', async (request, reply) => {
    const { token } = request.body as { token: string }

    if (!token) return reply.status(400).send({ error: 'token required' })

    let payload: any
    try {
      payload = jwt.verify(token, JWT_SECRET)
      if (payload.purpose !== 'migration') throw new Error('wrong purpose')
    } catch {
      return reply.status(401).send({ error: 'Invalid or expired migration token' })
    }

    const user = await db('users').where({ id: payload.user_id }).first()
    if (!user) return reply.status(404).send({ error: 'User not found' })

    const options = await generateRegistrationOptions({
      rpName:          RP_NAME,
      rpID:            NEW_RPID,
      userID:          Buffer.from(payload.user_id),
      userName:        `user_${payload.user_id.slice(0, 8)}`,
      userDisplayName: user.display_name || 'SynthPay User',
      attestationType: 'none',
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification:        'required',
        residentKey:             'preferred',
      },
      supportedAlgorithmIDs: [-7, -257],
    })

    await db('challenges').insert({
      challenge:  options.challenge,
      type:       'migration',
      user_id:    payload.user_id,
      expires_at: new Date(Date.now() + 5 * 60 * 1000),
    })

    return reply.send({ options })
  })

  // Step 3: Complete registration — adds passkey to existing user, issues new JWT
  server.post('/auth/migrate/complete', async (request, reply) => {
    const { token, credential } = request.body as { token: string; credential: any }

    if (!token || !credential) {
      return reply.status(400).send({ error: 'token and credential required' })
    }

    let payload: any
    try {
      payload = jwt.verify(token, JWT_SECRET)
      if (payload.purpose !== 'migration') throw new Error('wrong purpose')
    } catch {
      return reply.status(401).send({ error: 'Invalid or expired migration token' })
    }

    const stored = await db('challenges')
      .where({ type: 'migration', user_id: payload.user_id })
      .where('expires_at', '>', new Date())
      .orderBy('created_at', 'desc')
      .first()

    if (!stored) {
      return reply.status(400).send({ error: 'Challenge expired or not found' })
    }

    let verification: any
    try {
      verification = await verifyRegistrationResponse({
        response:                credential,
        expectedChallenge:       stored.challenge,
        expectedOrigin:          NEW_ORIGIN,
        expectedRPID:            NEW_RPID,
        requireUserVerification: true,
      })
    } catch (err: any) {
      return reply.status(400).send({ error: err.message })
    }

    if (!verification.verified || !verification.registrationInfo) {
      return reply.status(400).send({ error: 'Verification failed' })
    }

    const { credential: cred } = verification.registrationInfo

    // Add new passkey to the EXISTING user — no new account created
    await db('passkeys').insert({
      user_id:       payload.user_id,
      credential_id: cred.id,
      public_key:    Buffer.from(cred.publicKey).toString('base64'),
      counter:       cred.counter,
      device_type:   verification.registrationInfo.credentialDeviceType || 'unknown',
    })

    await db('challenges').where({ challenge: stored.challenge }).delete()

    const user = await db('users').where({ id: payload.user_id }).first()
    const newToken = jwt.sign({ user_id: payload.user_id }, JWT_SECRET, { expiresIn: '24h' })

    return reply.send({
      message: 'Passkey added for wallet.synthpay.tech — you can now sign in on this domain.',
      user_id: payload.user_id,
      balance: Number(user.balance),
      token:   newToken,
    })
  })

  // ── EMAIL RECOVERY ROUTES ─────────────────────────────────────────────────

  server.post('/auth/email/link', async (request, reply) => {
    const { user_id, email } = request.body as { user_id: string; email: string }

    if (!user_id || !email) {
      return reply.status(400).send({ error: 'user_id and email required' })
    }

    const emailLower = email.toLowerCase().trim()

    const existing = await db('users')
      .where({ email: emailLower })
      .whereNot({ id: user_id })
      .first()

    if (existing) {
      return reply.status(409).send({ error: 'Email already linked to another wallet' })
    }

    await db('users').where({ id: user_id }).update({ email: emailLower })

    return reply.send({
      success: true,
      message: 'Email linked to wallet. You can now use it for cross-device login.'
    })
  })

  server.post('/auth/email/check', async (request, reply) => {
    const { email } = request.body as { email: string }
    if (!email) return reply.status(400).send({ error: 'email required' })

    const user = await db('users')
      .where({ email: email.toLowerCase().trim() })
      .first()

    return reply.send({ exists: !!user })
  })

  server.post('/auth/email/request', async (request, reply) => {
    const { email } = request.body as { email: string }

    if (!email) {
      return reply.status(400).send({ error: 'email required' })
    }

    const emailLower = email.toLowerCase().trim()

    const user = await db('users').where({ email: emailLower }).first()
    if (!user) {
      return reply.send({
        success: true,
        message: 'If that email is linked to a wallet, a code has been sent.'
      })
    }

    const recentCount = await db('email_otps')
      .where({ email: emailLower })
      .where('created_at', '>', new Date(Date.now() - 10 * 60 * 1000))
      .count('id as count')
      .first()

    if (Number(recentCount?.count || 0) >= 3) {
      return reply.status(429).send({
        error: 'Too many codes requested. Please wait 10 minutes.'
      })
    }

    await db('email_otps')
      .where({ email: emailLower, used: false })
      .update({ used: true })

    const otp = generateOTP()
    await db('email_otps').insert({
      email:      emailLower,
      user_id:    user.id,
      otp,
      expires_at: new Date(Date.now() + OTP_EXPIRY),
      used:       false
    })

    await sendOTPEmail(emailLower, otp, user.id)

    return reply.send({
      success: true,
      message: 'If that email is linked to a wallet, a code has been sent.',
      ...(process.env.NODE_ENV === 'development' ? { dev_otp: otp } : {})
    })
  })

  server.post('/auth/email/verify', async (request, reply) => {
    const { email, otp } = request.body as { email: string; otp: string }

    if (!email || !otp) {
      return reply.status(400).send({ error: 'email and otp required' })
    }

    const emailLower = email.toLowerCase().trim()

    const record = await db('email_otps')
      .where({
        email: emailLower,
        otp:   otp.trim(),
        used:  false
      })
      .where('expires_at', '>', new Date())
      .first()

    if (!record) {
      return reply.status(401).send({ error: 'Invalid or expired code. Please request a new one.' })
    }

    await db('email_otps').where({ id: record.id }).update({ used: true })

    const user = await db('users').where({ id: record.user_id }).first()
    if (!user) {
      return reply.status(404).send({ error: 'User not found' })
    }

    const token = jwt.sign({ user_id: user.id }, JWT_SECRET, { expiresIn: '24h' })

    return reply.send({
      message: 'Login successful',
      user_id: user.id,
      balance: Number(user.balance),
      token,
    })
  })
}
