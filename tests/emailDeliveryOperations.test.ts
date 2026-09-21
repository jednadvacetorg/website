import assert from 'node:assert/strict'
import test from 'node:test'

import { emailVerificationTarget, parseEmailVerificationArgs } from '../scripts/verify-email-delivery.ts'

test('email operations verifier requires one explicit production target', () => {
  assert.deepEqual(parseEmailVerificationArgs(['preflight', '--target', 'production']), { mode: 'preflight', target: 'production' })
  assert.throws(() => emailVerificationTarget('preview'), /target production/)
  assert.throws(() => parseEmailVerificationArgs(['sandbox']), /Usage/)
})
