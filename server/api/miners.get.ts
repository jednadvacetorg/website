// Proxy pro filtered_workers.json (BraiinsPool workeři) — stejný důvod jako
// u /api/finance: zdroj běží na původním WordPressu bez CORS.
export default defineEventHandler(async (event) => {
  const data = await $fetch<Record<string, {
    hash_rate_24h_GH: number
    state: string
    last_share: number
  }>>('https://jednadvacet.org/wp-content/uploads/filtered_workers.json')

  setResponseHeader(event, 'Cache-Control', 'public, max-age=60')
  return data
})
