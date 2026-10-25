export const routedContentSources = {
  blogArticles: { directory: 'blog-articles', prefix: '/blog' },
  blogCategories: { directory: 'blog-categories', prefix: '/blog' },
  communities: { directory: 'communities', prefix: '/' },
  pages: { directory: 'pages', prefix: '/' },
} as const

export type RoutedContentCollection = keyof typeof routedContentSources

export const deriveContentPath = (relativeFilePath: string, prefix: string): string => {
  const path = relativeFilePath
    .replaceAll('\\', '/')
    .replace(/\.(?:md|mdc)$/i, '')
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .map(segment => segment.replace(/^\d+\./, ''))
    .join('/')
    .replace(/(?:^|\/)index$/i, '')

  const normalizedPrefix = `/${prefix}`.replace(/\/{2,}/g, '/').replace(/\/$/, '')
  return path ? `${normalizedPrefix}/${path}`.replace(/\/{2,}/g, '/') : normalizedPrefix || '/'
}
