# Changelog — @synthpay/trustledger

All notable changes to the TrustLedger service are documented here.
Follows [Semantic Versioning](https://semver.org): MAJOR.MINOR.PATCH.

Breaking changes require a MAJOR bump and a deprecation notice (minimum 30 days).

---

## [1.3.0] — 2026-05-09

### Added
- `POST /wallet/topup/intent` — creates a Stripe PaymentIntent and returns
  `client_secret` for the Stripe Payment Element (Block 12).
- Resend SDK integration in `auth_v2.ts` — `sendOTPEmail` now delivers real
  email via Resend with a branded HTML template (Block 22).
  Requires `RESEND_API_KEY` and `RESEND_FROM_EMAIL` env vars.
  Falls back to console log when `RESEND_API_KEY` is absent (dev).
- Vitest test suite: `tests/ledger.unit.test.ts` (mocked) and
  `tests/ledger.integration.test.ts` (live DB + concurrency).
- `npm run test:unit` and `npm run test:integration` scripts.
- `.env.staging` template for Railway staging service.

### Changed
- Package renamed to `@synthpay/trustledger`.

---

## [1.2.0] — 2026-04-15

### Added
- Idempotency key support on `POST /wallet/topup/create` — duplicate requests
  within the same key return the original result without a second charge.
- `email_otps` table migration (`add-email-otp.cjs`).
- Email OTP routes: `POST /auth/email/link`, `/auth/email/request`,
  `/auth/email/verify` with 10-minute expiry and 3-per-10-min rate limit.

### Changed
- `POST /wallet/topup/create` now accepts optional `idempotency_key`.

---

## [1.1.0] — 2026-03-20

### Added
- `GET /users/:user_id/history` — paginated transaction history (last 100).
- `GET /wallet/topups/:user_id` — topup history with `total_deposited` sum.
- Velocity check on `POST /users/pay` — $500 daily spend limit per user.
- Duplicate detection window (5 s) on pay endpoint.

### Changed
- `atomicDeduct` now calculates 1.5% platform fee and credits merchant in the
  same database transaction as the user deduction.

---

## [1.0.0] — 2026-02-10

### Added
- Initial release: Fastify server, PostgreSQL via Knex, 7-table schema.
- Passkey (WebAuthn) registration and authentication flows.
- `POST /users/pay` with atomic balance deduction.
- `POST /wallet/topup/create` with immediate balance credit.
- Stripe webhook handler for `payment_intent.succeeded`.
- Merchant dashboard routes: endpoints, payouts.
- Nightly audit job.
- `@fastify/rate-limit` global: 100 req/min.
- `@fastify/helmet` security headers.

---

## Deprecation Policy

- Deprecated routes are marked with `X-Deprecated` response header and a
  `deprecated` field in the JSON body.
- Deprecated routes are supported for **30 days** after the deprecation notice.
- MAJOR version bumps are announced in this file at least 14 days before release.
