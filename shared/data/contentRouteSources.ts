export const routedContentSources = {
  blogArticles: { directory: 'blog-articles', prefix: '/blog' },
  blogCategories: { directory: 'blog-categories', prefix: '/blog' },
  podcast: { directory: 'podcast', prefix: '/podcast' },
  communities: { directory: 'communities', prefix: '/' },
  pages: { directory: 'pages', prefix: '/' },
} as const

export type RoutedContentCollection = keyof typeof routedContentSources
