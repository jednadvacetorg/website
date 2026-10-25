// This build guard rejects content files that resolve to the same public URL or invade /blog.
// It is necessary because Nuxt Content validates each collection separately and cannot catch these cross-collection conflicts.
import { readdir } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { deriveContentPath, routedContentSources, type RoutedContentCollection } from '../shared/data/contentRouteSources.ts'

interface ContentRouteEntry {
  path: string
  collection: RoutedContentCollection
}

const findContentRouteCollisions = (entries: readonly ContentRouteEntry[]): string[] => {
  const entriesByPath = new Map<string, ContentRouteEntry[]>()

  for (const entry of entries) {
    const routes = entriesByPath.get(entry.path) ?? []
    routes.push(entry)
    entriesByPath.set(entry.path, routes)
  }

  return [...entriesByPath]
    .filter(([, routes]) => routes.length > 1)
    .map(([path, routes]) => `- ${path}: ${[...new Set(routes.map(route => route.collection))].sort().join(', ')}`)
    .sort()
}

const listMarkdownFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(entries.map(async entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return listMarkdownFiles(path)
    if (!entry.isFile() || !/\.(?:md|mdc)$/i.test(entry.name) || entry.name === 'README.md') return []
    return [path]
  }))

  return files.flat().sort()
}

const scanContentRoutes = async (contentRoot: string): Promise<ContentRouteEntry[]> => {
  const entries = await Promise.all(Object.entries(routedContentSources).map(async ([collection, source]) => {
    const collectionRoot = join(contentRoot, source.directory)
    const files = await listMarkdownFiles(collectionRoot)

    return files.map(file => ({
      path: deriveContentPath(relative(collectionRoot, file), source.prefix),
      collection: collection as RoutedContentCollection,
    }))
  }))

  return entries.flat()
}

const parseContentRoot = (): string => {
  const argumentIndex = process.argv.indexOf('--content-root')
  if (argumentIndex === -1) {
    return join(dirname(fileURLToPath(import.meta.url)), '../content')
  }

  const contentRoot = process.argv[argumentIndex + 1]
  if (!contentRoot) throw new Error('--content-root requires a directory path')
  return contentRoot
}

const entries = await scanContentRoutes(parseContentRoot())
const reservedBlogRoutes = entries
  .filter(entry => (
    (entry.collection === 'pages' || entry.collection === 'communities')
    && (entry.path === '/blog' || entry.path.startsWith('/blog/'))
  ))
  .sort((a, b) => a.path.localeCompare(b.path) || a.collection.localeCompare(b.collection))

if (reservedBlogRoutes.length) {
  throw new Error([
    'Root content uses the reserved /blog route namespace:',
    ...reservedBlogRoutes.map(entry => `- ${entry.path}: ${entry.collection}`),
    'Move these documents outside /blog; the explicit blog router owns this namespace.',
  ].join('\n'))
}

const collisions = findContentRouteCollisions(entries)

if (collisions.length) {
  throw new Error([
    'Public content route collisions detected:',
    ...collisions,
    'Rename one of the listed source files so every public path is unique.',
  ].join('\n'))
}

console.log('Content route validation passed: all routed collections have unique public paths.')
