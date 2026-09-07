import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildMapboxStaticUrl,
  generateCommunityMaps,
  parseBeruBitcoinPlaces,
  parseCommunityMapSource,
  selectPlacesForMap,
  type CommunityMapBlobStorage,
  type CommunityMapPlace,
} from '../server/utils/staticMap.ts'

const place = (id: number, longitude: number, latitude: number): CommunityMapPlace => ({
  id,
  longitude,
  latitude,
  acceptsLightning: true,
  acceptsOnchain: false,
  acceptsQerko: false,
})

test('queue payload is narrowed to a valid community map source', () => {
  assert.deepEqual(parseCommunityMapSource({
    slug: 'ceske-budejovice',
    map: { lat: 48.9757, lng: 14.4803, zoom: 11 },
    ignored: 'discard me',
  }), {
    slug: 'ceske-budejovice',
    map: { lat: 48.9757, lng: 14.4803, zoom: 11 },
  })
})

test('queue payload rejects malformed slugs, coordinates, and zoom', () => {
  assert.throws(() => parseCommunityMapSource({ slug: '../brno', map: { lat: 49.19, lng: 16.61 } }), /slug/)
  assert.throws(() => parseCommunityMapSource({ slug: 'brno', map: { lat: 90, lng: 16.61 } }), /coordinates/)
  assert.throws(() => parseCommunityMapSource({ slug: 'brno', map: { lat: 49.19, lng: 16.61, zoom: 30 } }), /zoom/)
})

test('BeruBitcoin payload is narrowed to map-safe fields and sorted by ID', () => {
  const parsed = parseBeruBitcoinPlaces([
    { id: 2, name: 'B', lngLat: [16.62, 49.2], accepts: {}, phone: 'discard me' },
    { id: 1, name: 'A', lngLat: [16.61, 49.19], accepts: { ln: true, qerko: true }, website: 'discard me' },
  ])

  assert.deepEqual(parsed, [
    { id: 1, longitude: 16.61, latitude: 49.19, acceptsLightning: true, acceptsOnchain: false, acceptsQerko: true },
    { id: 2, longitude: 16.62, latitude: 49.2, acceptsLightning: false, acceptsOnchain: false, acceptsQerko: false },
  ])
})

test('BeruBitcoin payload rejects duplicate IDs and malformed coordinates', () => {
  assert.throws(() => parseBeruBitcoinPlaces([
    { id: 1, name: 'A', lngLat: [16, 49], accepts: {} },
    { id: 1, name: 'B', lngLat: [17, 50], accepts: {} },
  ]), /place ID/)
  assert.throws(() => parseBeruBitcoinPlaces([
    { id: 1, name: 'A', lngLat: [16], accepts: {} },
  ]), /coordinates/)
})

test('viewport selection is deterministic and excludes distant places', () => {
  const input = [place(3, 14.8, 50.4), place(2, 14.438, 50.076), place(1, 14.4379, 50.0759)]
  const selected = selectPlacesForMap(input, { longitude: 14.4378, latitude: 50.0755 }, 12)
  const reversed = selectPlacesForMap([...input].reverse(), { longitude: 14.4378, latitude: 50.0755 }, 12)

  assert.deepEqual(selected.map(item => item.id), [1, 2])
  assert.deepEqual(reversed.map(item => item.id), [1, 2])
})

test('Mapbox URL is bounded and never includes descriptive upstream fields', () => {
  const manyPlaces = Array.from({ length: 2_000 }, (_, index) => place(index + 1, 14.4 + index / 1_000_000, 50.07))
  const { url, includedPlaceIds } = buildMapboxStaticUrl({
    center: { longitude: 14.4, latitude: 50.07 },
    places: manyPlaces,
    token: 'secret-token',
    zoom: 12,
  })

  assert(url.href.length <= 8192)
  assert(includedPlaceIds.length < manyPlaces.length)
  assert(url.pathname.startsWith('/styles/v1/mapbox/dark-v10/static/'))
  assert(url.pathname.endsWith('/960x540@2x.webp'))
  assert(decodeURIComponent(url.pathname).includes('"marker-color":"#f7931a"'))
  assert.equal(url.searchParams.get('access_token'), 'secret-token')
})

test('generator fetches places once and writes three 2x WebP variants per community', async () => {
  const calls: string[] = []
  const writes: Array<{ pathname: string, body: Uint8Array, contentType: string, community: string, variant: string }> = []
  const image = new Uint8Array([82, 73, 70, 70])
  const fetchImpl = async (input: string | URL | Request) => {
    const url = String(input)
    calls.push(url)
    if (url.includes('berubitcoin')) {
      return Response.json([{ id: 1, name: 'Place', lngLat: [16.61, 49.19], accepts: { ln: true } }])
    }
    return new Response(image, { headers: { 'content-type': 'image/webp' } })
  }
  const blob: CommunityMapBlobStorage = {
    put: async (pathname, body, options) => {
      writes.push({
        pathname,
        body: new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
        contentType: options.contentType,
        community: options.customMetadata.community!,
        variant: options.customMetadata.variant!,
      })
    },
  }

  const result = await generateCommunityMaps({
    token: 'secret-token',
    blob,
    fetchImpl,
    communities: [
      { slug: 'brno', map: { lat: 49.19, lng: 16.61, zoom: 12 } },
      { slug: 'praha', map: { lat: 50.08, lng: 14.44 } },
    ],
  })

  assert.deepEqual(result, { generated: 2, images: 6 })
  assert.equal(calls.filter(url => url.includes('berubitcoin')).length, 1)
  const mapboxCalls = calls.filter(url => url.includes('api.mapbox.com'))
  assert.equal(mapboxCalls.length, 6)
  assert.deepEqual(mapboxCalls.map(url => new URL(url).pathname.match(/\/(\d+x\d+@2x)\.webp$/)?.[1]), [
    '640x640@2x',
    '960x640@2x',
    '1280x540@2x',
    '640x640@2x',
    '960x640@2x',
    '1280x540@2x',
  ])
  assert.deepEqual(writes, [
    { pathname: 'community-maps/v1/brno-sm.webp', body: image, contentType: 'image/webp', community: 'brno', variant: 'sm' },
    { pathname: 'community-maps/v1/brno-md.webp', body: image, contentType: 'image/webp', community: 'brno', variant: 'md' },
    { pathname: 'community-maps/v1/brno-lg.webp', body: image, contentType: 'image/webp', community: 'brno', variant: 'lg' },
    { pathname: 'community-maps/v1/praha-sm.webp', body: image, contentType: 'image/webp', community: 'praha', variant: 'sm' },
    { pathname: 'community-maps/v1/praha-md.webp', body: image, contentType: 'image/webp', community: 'praha', variant: 'md' },
    { pathname: 'community-maps/v1/praha-lg.webp', body: image, contentType: 'image/webp', community: 'praha', variant: 'lg' },
  ])
})

test('generation requires a token before making requests or writes', async () => {
  let fetched = false
  let written = false
  await assert.rejects(generateCommunityMaps({
    token: '',
    communities: [],
    blob: { put: async () => { written = true } },
    fetchImpl: async () => {
      fetched = true
      throw new Error('must not fetch')
    },
  }), /not configured/)
  assert.equal(fetched, false)
  assert.equal(written, false)
})

test('BeruBitcoin network failures log the runtime error detail', async (t) => {
  const logs: string[] = []
  t.mock.method(console, 'error', (message: unknown) => logs.push(String(message)))

  await assert.rejects(generateCommunityMaps({
    token: 'secret-token',
    communities: [],
    blob: { put: async () => {} },
    fetchImpl: async () => {
      throw new TypeError('Network connection lost')
    },
  }), /BeruBitcoin places request failed/)

  assert.deepEqual(logs, [
    '[community-maps] BeruBitcoin fetch failed: TypeError: Network connection lost',
  ])
})

test('BeruBitcoin redirects are rejected without writing images', async () => {
  let redirect: RequestRedirect | undefined
  let writes = 0

  await assert.rejects(generateCommunityMaps({
    token: 'secret-token',
    communities: [{ slug: 'brno', map: { lat: 49.19, lng: 16.61 } }],
    blob: { put: async () => { writes += 1 } },
    fetchImpl: async (_input, init) => {
      redirect = init?.redirect
      return new Response(null, { status: 302, headers: { location: 'https://example.com/' } })
    },
  }), /BeruBitcoin places request failed with HTTP 302/)

  assert.equal(redirect, 'manual')
  assert.equal(writes, 0)
})

test('Mapbox network errors do not retain a token-bearing cause', async () => {
  const token = 'highly-sensitive-token'
  const fetchImpl = async (input: string | URL | Request) => {
    if (String(input).includes('berubitcoin')) {
      return Response.json([{ id: 1, name: 'Place', lngLat: [16.61, 49.19], accepts: {} }])
    }
    throw new Error(`request failed: ${String(input)}`)
  }

  await assert.rejects(
    generateCommunityMaps({
      token,
      blob: { put: async () => {} },
      fetchImpl,
      communities: [{ slug: 'brno', map: { lat: 49.19, lng: 16.61 } }],
    }),
    error => error instanceof Error
      && error.message === 'Mapbox image request failed for brno-sm'
      && error.cause === undefined
      && !String(error).includes(token),
  )
})

test('Mapbox redirects are rejected without writing images', async () => {
  let mapboxRedirect: RequestRedirect | undefined
  let writes = 0
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).includes('berubitcoin')) {
      return Response.json([{ id: 1, name: 'Place', lngLat: [16.61, 49.19], accepts: {} }])
    }
    mapboxRedirect = init?.redirect
    return new Response(null, { status: 302, headers: { location: 'https://example.com/' } })
  }

  await assert.rejects(generateCommunityMaps({
    token: 'secret-token',
    communities: [{ slug: 'brno', map: { lat: 49.19, lng: 16.61 } }],
    blob: { put: async () => { writes += 1 } },
    fetchImpl,
  }), /Mapbox image request failed for brno-sm with HTTP 302/)

  assert.equal(mapboxRedirect, 'manual')
  assert.equal(writes, 0)
})

for (const status of [401, 403, 404, 410, 422, 429]) {
  test(`Mapbox HTTP ${status} fails without leaking the token`, async () => {
    const token = 'highly-sensitive-token'
    const fetchImpl = async (input: string | URL | Request) => {
      if (String(input).includes('berubitcoin')) {
        return Response.json([{ id: 1, name: 'Place', lngLat: [16.61, 49.19], accepts: {} }])
      }
      return new Response('failure', { status })
    }

    await assert.rejects(
      generateCommunityMaps({
        token,
        blob: { put: async () => {} },
        fetchImpl,
        communities: [{ slug: 'brno', map: { lat: 49.19, lng: 16.61 } }],
      }),
      error => error instanceof Error && error.message.includes(`HTTP ${status}`) && !error.message.includes(token),
    )
  })
}

test('invalid Mapbox content never overwrites an existing R2 object', async () => {
  let writes = 0
  const fetchImpl = async (input: string | URL | Request) => {
    if (String(input).includes('berubitcoin')) {
      return Response.json([{ id: 1, name: 'Place', lngLat: [16.61, 49.19], accepts: {} }])
    }
    return new Response('not an image', { headers: { 'content-type': 'text/plain' } })
  }

  await assert.rejects(generateCommunityMaps({
    token: 'secret-token',
    communities: [{ slug: 'brno', map: { lat: 49.19, lng: 16.61 } }],
    fetchImpl,
    blob: { put: async () => { writes += 1 } },
  }), /not WebP/)
  assert.equal(writes, 0)
})
