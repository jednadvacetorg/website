import { globSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { defineNuxtModule, extendRouteRules } from '@nuxt/kit'
import { z } from '@nuxt/content'
import { parse } from 'yaml'
import { deriveContentPath, routedContentSources } from './data/contentRouteSources'
import { isPublishedBlogFile } from './utils/blogPublication'

const redirectSchema = z.object({
  path: z.string().optional(),
  redirect_from: z.array(z.string()).optional(),
})

export default defineNuxtModule({
  async setup(_, nuxt) {
    // Architectural decision: resolve redirect_from at build time, not per request.
    // Normal blog pages must remain prerendered and asset-served on Cloudflare;
    // a redirect middleware must not query Content or force them back into SSR.
    //
    // Read source frontmatter on EVERY build. content:file:afterParse only runs
    // for cache misses, so using it to register route rules silently loses
    // redirects on warm-cache builds (even though they work in development).
    // Scheduled articles are omitted here just as they are in content.config.ts;
    // publication requires a new build/deployment, not a runtime date check.
    //
    // When changing this, verify redirects with "0 parsed" in the build log AND
    // verify that blog HTML still exists in .output/public. See README.md,
    // "Přesměrování starých adres", for the rationale and verification checklist.
    for (const [collection, source] of Object.entries(routedContentSources)) {
      const directory = join(nuxt.options.rootDir, 'content', source.directory)
      for (const file of globSync('**/*.{md,mdc}', { cwd: directory })) {
        if (basename(file) === 'README.md') continue
        if (collection === 'blogArticles' && !isPublishedBlogFile(file)) continue

        const body = await readFile(join(directory, file), 'utf8')
        const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(body)
        if (!frontmatter) continue
        const content = redirectSchema.parse(parse(frontmatter[1]!))
        const path = content.path ?? deriveContentPath(file, source.prefix)
        for (const from of content.redirect_from ?? []) {
          extendRouteRules(from, { redirect: { to: path, statusCode: 301 } })
        }
      }
    }
  },
})
