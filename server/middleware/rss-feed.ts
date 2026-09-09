import { defineEventHandler, getRequestURL } from 'h3'

const rssXml = `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0">
  <channel>
    <title>Jednadvacet</title>
    <link>https://jednadvacet.org/</link>
    <description>Jednadvacet</description>
    <language>cs</language>
    <item>
      <title>RSS kanál zrušen</title>
      <link>https://jednadvacet.org/</link>
      <guid isPermaLink="true">https://jednadvacet.org/</guid>
      <pubDate>Wed, 09 Sep 2026 00:00:00 GMT</pubDate>
      <description><![CDATA[Používal jsi ho a chybí ti? Napiš Honzovi: https://signal.me/#eu/kjoieEVFZFTtXGS95Bhl4z3Gl4S7b3Dajq2ptOHmc5YNTd_tsWhBSKyQg7WSZW5q]]></description>
    </item>
  </channel>
</rss>
`

export default defineEventHandler((event) => {
  if (!getRequestURL(event).pathname.endsWith('/feed/')) return

  return new Response(rssXml, {
    headers: {
      'content-type': 'application/rss+xml; charset=utf-8',
      'x-content-type-options': 'nosniff',
    },
  })
})
