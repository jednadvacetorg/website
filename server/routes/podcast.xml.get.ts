import { queryCollection } from '@nuxt/content/server'
import { defineEventHandler, setResponseHeaders } from 'h3'
import { podcast } from '#shared/data/social'

const escapeXml = (value: string | number) => String(value).replace(/[<>&"']/g, character => ({
  '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;',
})[character]!)

export default defineEventHandler(async (event) => {
  const [episodes, articles, people, categories] = await Promise.all([
    queryCollection(event, 'podcast').order('id', 'DESC').all(),
    queryCollection(event, 'blogArticles').where('audio', 'IS NOT NULL').order('id', 'DESC').all(),
    queryCollection(event, 'people').select('path', 'title').all(),
    queryCollection(event, 'blogCategories').select('path', 'title').all(),
  ])

  const siteUrl = getSiteConfig(event).url
  const absoluteUrl = (path: string) => new URL(path, siteUrl).href
  const names = new Map(people.map(person => [person.path.split('/').pop(), person.title]))
  const categoryNames = new Map(categories.map(category => [category.path.split('/').pop(), category.title]))
  const items = [...episodes, ...articles].filter(item => item.audio)
    .sort((a, b) => (b.published ?? '').localeCompare(a.published ?? '') || b.id.localeCompare(a.id))

  const coverUrl = (path: string, title: string, image: string) => getOgImageUrl(event, path, {
    component: 'Article', width: 1400, height: 1400, extension: 'png',
    props: { title, image, format: 'square', podcast: path === '/podcast' || path.startsWith('/podcast/') },
  })
  const channelImage = episodes[0]?.thumbnail ?? items[0]?.thumbnail
  const channelCover = podcast.cover ? absoluteUrl(podcast.cover)
    : channelImage ? coverUrl('/podcast', 'Jednadvacet podcast', channelImage) : undefined

  const xmlItems = items.map(item => {
    const link = absoluteUrl(item.path)
    const extension = new URL(item.audio!).pathname.split('.').pop()?.toLowerCase()
    const mimeType = ({ m4a: 'audio/mp4', mp4: 'audio/mp4', ogg: 'audio/ogg', wav: 'audio/wav' } as Record<string, string>)[extension ?? ''] ?? 'audio/mpeg'
    const author = item.authors?.map(slug => names.get(slug) ?? slug).join(', ')
    return `<item>
      <title>${escapeXml(item.title)}</title>
      <link>${escapeXml(link)}</link>
      <guid isPermaLink="true">${escapeXml(link)}</guid>
      <description>${escapeXml(item.description)}</description>
      ${item.published ? `<pubDate>${new Date(`${item.published}T00:00:00Z`).toUTCString()}</pubDate>` : ''}
      <enclosure url="${escapeXml(item.audio!)}"${item.audioLength ? ` length="${item.audioLength}"` : ''} type="${mimeType}" />
      ${item.audioDuration ? `<itunes:duration>${item.audioDuration}</itunes:duration>` : ''}
      ${author ? `<itunes:author>${escapeXml(author)}</itunes:author>` : ''}
      <itunes:explicit>false</itunes:explicit>
      <itunes:image href="${escapeXml(item.cover ? absoluteUrl(item.cover) : coverUrl(item.path, item.title, item.thumbnail))}" />
      ${(item.categories ?? []).map(slug => `<category>${escapeXml(categoryNames.get(slug) ?? slug)}</category>`).join('\n')}
    </item>`
  }).join('\n')

  setResponseHeaders(event, {
    'content-type': 'application/rss+xml; charset=utf-8',
    'cache-control': 'public, max-age=3600',
    'x-content-type-options': 'nosniff',
  })

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Jednadvacet podcast</title>
    <link>${escapeXml(absoluteUrl('/podcast'))}</link>
    <description>Rozhovory z bitcoinové komunity a audioverze článků Jednadvacet.</description>
    <language>cs</language>
    <atom:link href="${escapeXml(absoluteUrl(podcast.platforms.rss.to))}" rel="self" type="application/rss+xml" />
    <itunes:author>Jednadvacet</itunes:author>
    <itunes:owner><itunes:name>Jednadvacet</itunes:name><itunes:email>info@jednadvacet.org</itunes:email></itunes:owner>
    <itunes:explicit>false</itunes:explicit>
    <itunes:category text="Technology" />
    ${channelCover ? `<itunes:image href="${escapeXml(channelCover)}" />` : ''}
    ${xmlItems}
  </channel>
</rss>`
})
