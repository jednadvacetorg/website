import assert from 'node:assert/strict'
import test from 'node:test'

import { emailVerificationTarget, parseEmailVerificationArgs, preflightEmailDelivery } from '../scripts/verify-email-delivery.ts'

test('email operations verifier requires one explicit production target', () => {
  assert.deepEqual(parseEmailVerificationArgs(['preflight', '--target', 'production']), { mode: 'preflight', target: 'production' })
  assert.throws(() => emailVerificationTarget('preview'), /target production/)
  assert.throws(() => parseEmailVerificationArgs(['sandbox']), /Usage/)
})

test('email operations preflight requires the single notification root', async () => {
  const environment = {
    NUXT_BREVO_API_KEY: 'key',
    NUXT_BREVO_CALLBACK_SECRET: 'callback',
    NUXT_NOTIFICATION_ROOT_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  }
  await assert.rejects(preflightEmailDelivery('/tmp/not-present.json', {
    ...environment,
    NUXT_NOTIFICATION_ROOT_KEY: '',
    NUXT_NOTIFICATION_ROOT_KEYS: 'former',
  }), /NUXT_NOTIFICATION_ROOT_KEY/)
})
