// Proxy pro finance.json z původního WordPressu — soubor generuje cron mimo
// tento web a nemá CORS hlavičky, takže ho prohlížeč nemůže číst napřímo.
export default defineEventHandler(async (event) => {
  const data = await $fetch<{
    balance: number
    unused_address: string
    ln_address: string
  }>('https://jednadvacet.org/wp-content/uploads/finance.json')

  setResponseHeader(event, 'Cache-Control', 'public, max-age=60')
  return data
})
