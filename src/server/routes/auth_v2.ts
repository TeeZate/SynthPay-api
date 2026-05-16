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
import { Resend } from 'resend'

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null

const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'SynthPay <noreply@synthpay.io>'

const RP_NAME    = 'SynthPay'
const RP_ID      = process.env.WEBAUTHN_RPID   || 'localhost'
const ORIGIN     = process.env.WEBAUTHN_ORIGIN || 'http://localhost:3000'
const JWT_SECRET = process.env.JWT_SECRET      || 'changeme'
const OTP_EXPIRY = 10 * 60 * 1000             // 10 minutes

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
  if (!resend) {
    // Dev fallback — no Resend key configured
    console.log(`[DEV OTP] ${email} → ${otp} (user ${userId.slice(0, 8)}...)`)
    return
  }

  const expiresAt = new Date(Date.now() + OTP_EXPIRY).toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short'
  })

  await resend.emails.send({
    from:    FROM_EMAIL,
    to:      email,
    subject: `${otp} — Your SynthPay login code`,
    html: `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#03030a;font-family:monospace,Courier New,monospace;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#03030a;padding:40px 20px;">
    <tr><td align="center">
      <table width="100%" style="max-width:480px;background:#0a0a14;border:1px solid #1a1a2e;border-radius:16px;overflow:hidden;">
        <!-- Header -->
        <tr><td style="padding:32px 32px 0;text-align:center;">
          <p style="margin:0;font-size:11px;letter-spacing:4px;color:#334155;">SYNTHPAY</p>
          <h1 style="margin:12px 0 0;font-size:22px;font-weight:800;color:#e2e8f0;">Your login code</h1>
        </td></tr>
        <!-- OTP -->
        <tr><td style="padding:32px;text-align:center;">
          <div style="background:#050510;border:1px solid rgba(0,229,255,0.2);border-radius:12px;padding:28px;display:inline-block;width:100%;box-sizing:border-box;">
            <p style="margin:0 0 8px;font-size:11px;letter-spacing:3px;color:#334155;">ONE-TIME CODE</p>
            <p style="margin:0;font-size:48px;font-weight:900;color:#00e5ff;letter-spacing:12px;">${otp}</p>
          </div>
          <p style="margin:20px 0 0;font-size:13px;color:#64748b;">Expires at ${expiresAt}</p>
        </td></tr>
        <!-- Footer -->
        <tr><td style="padding:0 32px 32px;text-align:center;border-top:1px solid #0d0d1e;">
          <p style="margin:20px 0 0;font-size:12px;color:#334155;">If you didn't request this code, you can safely ignore this email.</p>
          <p style="margin:8px 0 0;font-size:11px;color:#1a2a3a;letter-spacing:2px;">SYNTHPAY · PAY PER USE</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
  })
}

export const authRoutes = async (server: FastifyInstance) => {

  // ── 2.02 REGISTRATION BEGIN ───────────────────────────────────────────────
  server.post('/auth/register/begin', async (request, reply) => {
    await cleanChallenges()

    const userId = randomBytes(16).toString('hex')

    const options = await generateRegistrationOptions({
      rpName:          RP_NAME,
      rpID:            RP_ID,
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

    let verification: any
    try {
      verification = await verifyRegistrationResponse({
        response:                credential,
        expectedChallenge:       stored.challenge,
        expectedOrigin:          ORIGIN,
        expectedRPID:            RP_ID,
        requireUserVerification: true,
      })
    } catch (err: any) {
      return reply.status(400).send({ error: err.message })
    }

    if (!verification.verified || !verification.registrationInfo) {
      return reply.status(400).send({ error: 'Verification failed' })
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
      message: 'Account created successfully',
      user_id: user.id,
      balance: Number(user.balance),
      token,
    })
  })

  // ── 2.04 LOGIN BEGIN ──────────────────────────────────────────────────────
  server.post('/auth/login/begin', async (request, reply) => {
    await cleanChallenges()

    const options = await generateAuthenticationOptions({
      rpID:             RP_ID,
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

    let verification: any
    try {
      verification = await verifyAuthenticationResponse({
        response:          credential,
        expectedChallenge: stored.challenge,
        expectedOrigin:    ORIGIN,
        expectedRPID:      RP_ID,
        credential: {
          id:        passkey.credential_id,
          publicKey: new Uint8Array(Buffer.from(passkey.public_key, 'base64')),
          counter:   passkey.counter,
        },
        requireUserVerification: true,
      })
    } catch (err: any) {
      return reply.status(400).send({ error: err.message })
    }

    if (!verification.verified) {
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

  // ── EMAIL RECOVERY ROUTES ─────────────────────────────────────────────────

  // Link email to existing account (call after passkey login)
  server.post('/auth/email/link', async (request, reply) => {
    const { user_id, email } = request.body as { user_id: string; email: string }

    if (!user_id || !email) {
      return reply.status(400).send({ error: 'user_id and email required' })
    }

    const emailLower = email.toLowerCase().trim()

    // Check email not already used by another user
    const existing = await db('users')
      .where({ email: emailLower })
      .whereNot({ id: user_id })
      .first()

    if (existing) {
      return reply.status(409).send({ error: 'Email already linked to another account' })
    }

    await db('users').where({ id: user_id }).update({ email: emailLower })

    return reply.send({
      success: true,
      message: 'Email linked to account. You can now use it for cross-device login.'
    })
  })

  // Check if email is linked to an account
  server.post('/auth/email/check', async (request, reply) => {
    const { email } = request.body as { email: string }
    if (!email) return reply.status(400).send({ error: 'email required' })

    const user = await db('users')
      .where({ email: email.toLowerCase().trim() })
      .first()

    return reply.send({ exists: !!user })
  })

  // Request OTP — send code to email
  server.post('/auth/email/request', async (request, reply) => {
    const { email } = request.body as { email: string }

    if (!email) {
      return reply.status(400).send({ error: 'email required' })
    }

    const emailLower = email.toLowerCase().trim()

    // Find user by email
    const user = await db('users').where({ email: emailLower }).first()
    if (!user) {
      // Don't reveal if email exists — security best practice
      return reply.send({
        success: true,
        message: 'If that email is linked to an account, a code has been sent.'
      })
    }

    // Rate limit — max 3 OTPs per 10 minutes per email
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

    // Invalidate previous OTPs for this email
    await db('email_otps')
      .where({ email: emailLower, used: false })
      .update({ used: true })

    // Generate and store new OTP
    const otp = generateOTP()
    await db('email_otps').insert({
      email:      emailLower,
      user_id:    user.id,
      otp,
      expires_at: new Date(Date.now() + OTP_EXPIRY),
      used:       false
    })

    // Send email (currently logs to console)
    await sendOTPEmail(emailLower, otp, user.id)

    return reply.send({
      success: true,
      message: 'If that email is linked to a wallet, a code has been sent.',
      // In development — remove in production
      ...(process.env.NODE_ENV === 'development' ? { dev_otp: otp } : {})
    })
  })

  // Verify OTP — returns JWT on success
  server.post('/auth/email/verify', async (request, reply) => {
    const { email, otp } = request.body as { email: string; otp: string }

    if (!email || !otp) {
      return reply.status(400).send({ error: 'email and otp required' })
    }

    const emailLower = email.toLowerCase().trim()

    // Find valid OTP
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

    // Mark OTP as used — can only be used once
    await db('email_otps').where({ id: record.id }).update({ used: true })

    // Get user
    const user = await db('users').where({ id: record.user_id }).first()
    if (!user) {
      return reply.status(404).send({ error: 'User not found' })
    }

    // Issue JWT — same as passkey login
    const token = jwt.sign({ user_id: user.id }, JWT_SECRET, { expiresIn: '24h' })

    return reply.send({
      message: 'Login successful',
      user_id: user.id,
      balance: Number(user.balance),
      token,
    })
  })
}
