import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isPublishedBlogFile } from '../shared/utils/blogPublication.ts'

test('publication day changes at Czech midnight during summer time', () => {
  const file = '20261025.kalendarium-442026.md'
  assert.equal(isPublishedBlogFile(file, new Date('2026-10-24T21:59:59.999Z')), false)
  assert.equal(isPublishedBlogFile(file, new Date('2026-10-24T22:00:00.000Z')), true)
})

test('publication day changes at Czech midnight during winter time', () => {
  const file = '20261101.kalendarium-452026.md'
  assert.equal(isPublishedBlogFile(file, new Date('2026-10-31T22:59:59.999Z')), false)
  assert.equal(isPublishedBlogFile(file, new Date('2026-10-31T23:00:00.000Z')), true)
})

test('publication works across year boundaries and with Windows paths', () => {
  const file = 'blog-articles\\20270101.novy-rok.md'
  assert.equal(isPublishedBlogFile(file, new Date('2026-12-31T22:59:59Z')), false)
  assert.equal(isPublishedBlogFile(file, new Date('2026-12-31T23:00:00Z')), true)
})

test('a build includes past and same-day articles, but excludes future articles', () => {
  const now = new Date('2026-10-24T22:00:00Z')
  assert.equal(isPublishedBlogFile('20261018.kalendarium-432026.md', now), true)
  assert.equal(isPublishedBlogFile('blog-articles/20261025.kalendarium-442026.md', now), true)
  assert.equal(isPublishedBlogFile('20261101.kalendarium-452026.md', now), false)
  assert.equal(isPublishedBlogFile('README.md', now), true)
})
