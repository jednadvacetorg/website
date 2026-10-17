// This suite protects the shared public URL space used by pages, communities, and blog content.
// Keep it because a collision can silently make valid content unreachable even when Nuxt builds successfully.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

test('source validator accepts unique routes with nested indexes', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'content-routes-valid-'))

  try {
    await mkdir(join(fixtureRoot, 'pages', 'mesta'), { recursive: true })
    await mkdir(join(fixtureRoot, 'communities'), { recursive: true })
    await mkdir(join(fixtureRoot, 'blog-articles'), { recursive: true })
    await mkdir(join(fixtureRoot, 'blog-categories'), { recursive: true })
    await mkdir(join(fixtureRoot, 'podcast'), { recursive: true })
    await writeFile(join(fixtureRoot, 'pages', 'mesta', 'index.md'), '---\ntitle: Cities\n---\n')
    await writeFile(join(fixtureRoot, 'communities', 'brno.md'), '---\ntitle: Brno\n---\n')

    const result = spawnSync(process.execPath, [
      '--experimental-strip-types',
      join(import.meta.dirname, '../scripts/validate-content-routes.ts'),
      '--content-root',
      fixtureRoot,
    ], { encoding: 'utf8' })

    assert.equal(result.status, 0, result.stderr)
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('source validator exits non-zero and names every colliding path and collection', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'content-routes-'))

  try {
    await mkdir(join(fixtureRoot, 'pages', 'shared'), { recursive: true })
    await mkdir(join(fixtureRoot, 'communities', 'shared'), { recursive: true })
    await mkdir(join(fixtureRoot, 'blog-articles'), { recursive: true })
    await mkdir(join(fixtureRoot, 'blog-categories'), { recursive: true })
    await mkdir(join(fixtureRoot, 'podcast'), { recursive: true })
    await writeFile(join(fixtureRoot, 'pages', 'brno.md'), '---\ntitle: Page\n---\n')
    await writeFile(join(fixtureRoot, 'communities', 'brno.md'), '---\ntitle: Community\n---\n')
    await writeFile(join(fixtureRoot, 'pages', 'shared', 'index.md'), '---\ntitle: Page index\n---\n')
    await writeFile(join(fixtureRoot, 'communities', 'shared', 'index.md'), '---\ntitle: Community index\n---\n')

    const result = spawnSync(process.execPath, [
      '--experimental-strip-types',
      join(import.meta.dirname, '../scripts/validate-content-routes.ts'),
      '--content-root',
      fixtureRoot,
    ], { encoding: 'utf8' })

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Public content route collisions detected:/)
    assert.match(result.stderr, /- \/brno: communities, pages/)
    assert.match(result.stderr, /- \/shared: communities, pages/)
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('source validator rejects same-collection collisions from ordering prefixes', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'content-routes-ordering-prefix-'))

  try {
    await mkdir(join(fixtureRoot, 'pages'), { recursive: true })
    await mkdir(join(fixtureRoot, 'communities'), { recursive: true })
    await mkdir(join(fixtureRoot, 'blog-articles'), { recursive: true })
    await mkdir(join(fixtureRoot, 'blog-categories'), { recursive: true })
    await mkdir(join(fixtureRoot, 'podcast'), { recursive: true })
    await writeFile(join(fixtureRoot, 'pages', 'brno.md'), '---\ntitle: Brno\n---\n')
    await writeFile(join(fixtureRoot, 'pages', '1.brno.md'), '---\ntitle: Ordered Brno\n---\n')

    const result = spawnSync(process.execPath, [
      '--experimental-strip-types',
      join(import.meta.dirname, '../scripts/validate-content-routes.ts'),
      '--content-root',
      fixtureRoot,
    ], { encoding: 'utf8' })

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /- \/brno: pages/)
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('source validator rejects article and category collisions under /blog', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'content-routes-blog-'))

  try {
    await mkdir(join(fixtureRoot, 'pages'), { recursive: true })
    await mkdir(join(fixtureRoot, 'communities'), { recursive: true })
    await mkdir(join(fixtureRoot, 'blog-articles'), { recursive: true })
    await mkdir(join(fixtureRoot, 'blog-categories'), { recursive: true })
    await mkdir(join(fixtureRoot, 'podcast'), { recursive: true })
    await writeFile(join(fixtureRoot, 'blog-articles', '20260101.kalendar.md'), '---\ntitle: Article\nthumbnail: /test.jpg\n---\n')
    await writeFile(join(fixtureRoot, 'blog-categories', 'kalendar.md'), '---\ntitle: Category\n---\n')

    const result = spawnSync(process.execPath, [
      '--experimental-strip-types',
      join(import.meta.dirname, '../scripts/validate-content-routes.ts'),
      '--content-root',
      fixtureRoot,
    ], { encoding: 'utf8' })

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /- \/blog\/kalendar: blogArticles, blogCategories/)
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

for (const namespace of ['blog', 'podcast']) {
test(`source validator rejects root content in the reserved /${namespace} namespace`, async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'content-routes-reserved-blog-'))

  try {
    await mkdir(join(fixtureRoot, 'pages', namespace), { recursive: true })
    await mkdir(join(fixtureRoot, 'communities'), { recursive: true })
    await mkdir(join(fixtureRoot, 'blog-articles'), { recursive: true })
    await mkdir(join(fixtureRoot, 'blog-categories'), { recursive: true })
    await mkdir(join(fixtureRoot, 'podcast'), { recursive: true })
    await writeFile(join(fixtureRoot, 'pages', namespace, 'hidden.md'), '---\ntitle: Hidden page\n---\n')

    const result = spawnSync(process.execPath, [
      '--experimental-strip-types',
      join(import.meta.dirname, '../scripts/validate-content-routes.ts'),
      '--content-root',
      fixtureRoot,
    ], { encoding: 'utf8' })

    assert.notEqual(result.status, 0)
    assert.ok(result.stderr.includes(`Root content uses the reserved /${namespace} route namespace:`))
    assert.ok(result.stderr.includes(`- /${namespace}/hidden: pages`))

    await rm(join(fixtureRoot, 'pages', namespace), { recursive: true, force: true })
    await writeFile(join(fixtureRoot, 'pages', `${namespace}.md`), '---\ntitle: Hidden index\n---\n')

    const indexResult = spawnSync(process.execPath, [
      '--experimental-strip-types',
      join(import.meta.dirname, '../scripts/validate-content-routes.ts'),
      '--content-root',
      fixtureRoot,
    ], { encoding: 'utf8' })

    assert.notEqual(indexResult.status, 0)
    assert.ok(indexResult.stderr.includes(`- /${namespace}: pages`))
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})
}
