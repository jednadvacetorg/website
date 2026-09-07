const BERUBITCOIN_URL = 'https://mapa.berubitcoin.cz/api/places'
const DEFAULT_MAPBOX_STYLE = 'mapbox/dark-v10'
const DEFAULT_ZOOM = 12
const DEFAULT_IMAGE_WIDTH = 960
const DEFAULT_IMAGE_HEIGHT = 540
const MAX_JSON_BYTES = 5_000_000
const MAX_IMAGE_BYTES = 10_000_000
const MAX_MAPBOX_URL_LENGTH = 8192
const MARKER_PADDING = 20

const COMMUNITY_MAP_VARIANTS = [
  { name: 'sm', width: 640, height: 640 },
  { name: 'md', width: 960, height: 640 },
  { name: 'lg', width: 1280, height: 540 },
] as const

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface CommunityMapSource {
  slug: string
  map: {
    lat: number
    lng: number
    zoom?: number
  }
}

export interface CommunityMapPlace {
  id: number
  latitude: number
  longitude: number
  acceptsLightning: boolean
  acceptsOnchain: boolean
  acceptsQerko: boolean
}

export interface CommunityMapBlobStorage {
  put: (
    pathname: string,
    body: ArrayBufferView,
    options: { contentType: string, customMetadata: Record<string, string> },
  ) => Promise<unknown>
}

interface GenerateCommunityMapsOptions {
  token: string
  communities: readonly CommunityMapSource[]
  blob: CommunityMapBlobStorage
  style?: string
  fetchImpl?: FetchLike
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

const assertFiniteNumber = (value: unknown, field: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid ${field}: expected a finite number`)
  }

  return value
}

const readResponseBytes = async (response: Response, maximumBytes: number): Promise<Uint8Array> => {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error(`Response exceeds ${maximumBytes} bytes`)
  }

  if (!response.body) return new Uint8Array()

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maximumBytes) {
      await reader.cancel()
      throw new Error(`Response exceeds ${maximumBytes} bytes`)
    }
    chunks.push(value)
  }

  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

export const parseBeruBitcoinPlaces = (value: unknown): CommunityMapPlace[] => {
  if (!Array.isArray(value)) throw new Error('Invalid BeruBitcoin payload: expected an array')

  const ids = new Set<number>()
  const places = value.map((entry, index): CommunityMapPlace => {
    if (!isRecord(entry)) throw new Error(`Invalid BeruBitcoin place at index ${index}`)

    const id = assertFiniteNumber(entry.id, `place[${index}].id`)
    if (!Number.isSafeInteger(id) || ids.has(id)) {
      throw new Error(`Invalid BeruBitcoin place ID at index ${index}`)
    }
    ids.add(id)

    if (typeof entry.name !== 'string' || !entry.name.trim()) {
      throw new Error(`Invalid BeruBitcoin place name at index ${index}`)
    }
    if (!Array.isArray(entry.lngLat) || entry.lngLat.length !== 2) {
      throw new Error(`Invalid BeruBitcoin coordinates at index ${index}`)
    }

    const longitude = assertFiniteNumber(entry.lngLat[0], `place[${index}].lngLat[0]`)
    const latitude = assertFiniteNumber(entry.lngLat[1], `place[${index}].lngLat[1]`)
    if (longitude < -180 || longitude > 180 || latitude < -85.0511 || latitude > 85.0511) {
      throw new Error(`Out-of-range BeruBitcoin coordinates at index ${index}`)
    }
    if (!isRecord(entry.accepts)) {
      throw new Error(`Invalid BeruBitcoin accepts object at index ${index}`)
    }

    for (const key of ['ln', 'onchain', 'qerko']) {
      const accepted = entry.accepts[key]
      if (accepted !== undefined && typeof accepted !== 'boolean') {
        throw new Error(`Invalid BeruBitcoin accepts.${key} at index ${index}`)
      }
    }

    return {
      id,
      latitude,
      longitude,
      acceptsLightning: entry.accepts.ln === true,
      acceptsOnchain: entry.accepts.onchain === true,
      acceptsQerko: entry.accepts.qerko === true,
    }
  })

  return places.sort((left, right) => left.id - right.id)
}

const projectToWorldPixels = (longitude: number, latitude: number, zoom: number) => {
  const worldSize = 512 * 2 ** zoom
  const clampedLatitude = Math.max(-85.0511, Math.min(85.0511, latitude))
  const radians = clampedLatitude * Math.PI / 180

  return {
    x: (longitude + 180) / 360 * worldSize,
    y: (1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2 * worldSize,
    worldSize,
  }
}

export const selectPlacesForMap = (
  places: readonly CommunityMapPlace[],
  center: { latitude: number, longitude: number },
  zoom: number,
  width = DEFAULT_IMAGE_WIDTH,
  height = DEFAULT_IMAGE_HEIGHT,
): CommunityMapPlace[] => {
  const projectedCenter = projectToWorldPixels(center.longitude, center.latitude, zoom)

  return places
    .map((place) => {
      const projectedPlace = projectToWorldPixels(place.longitude, place.latitude, zoom)
      const rawX = Math.abs(projectedPlace.x - projectedCenter.x)
      const x = Math.min(rawX, projectedCenter.worldSize - rawX)
      const y = Math.abs(projectedPlace.y - projectedCenter.y)
      return { place, x, y, distance: x ** 2 + y ** 2 }
    })
    .filter(({ x, y }) => x <= width / 2 + MARKER_PADDING && y <= height / 2 + MARKER_PADDING)
    .sort((left, right) => left.distance - right.distance || left.place.id - right.place.id)
    .map(({ place }) => place)
}

const mapboxStyleParts = (style: string): [string, string] => {
  const match = style.match(/^([a-z0-9_-]+)\/([a-z0-9_-]+)$/i)
  if (!match) throw new Error('Mapbox style must use the username/style-id format')
  return [match[1]!, match[2]!]
}

export const buildMapboxStaticUrl = ({
  center,
  places,
  token,
  style = DEFAULT_MAPBOX_STYLE,
  zoom,
  width = DEFAULT_IMAGE_WIDTH,
  height = DEFAULT_IMAGE_HEIGHT,
}: {
  center: { latitude: number, longitude: number }
  places: readonly CommunityMapPlace[]
  token: string
  style?: string
  zoom: number
  width?: number
  height?: number
}): { url: URL, includedPlaceIds: number[] } => {
  const [username, styleId] = mapboxStyleParts(style)
  const selected = [...places]

  const createUrl = () => {
    const coordinates = selected.map(place => [
      Number(place.longitude.toFixed(6)),
      Number(place.latitude.toFixed(6)),
    ])
    const overlay = coordinates.length
      ? `geojson(${encodeURIComponent(JSON.stringify({
          type: 'Feature',
          properties: {
            'marker-color': '#f7931a',
            'marker-size': 'small',
          },
          geometry: { type: 'MultiPoint', coordinates },
        }))})/`
      : ''
    const camera = `${center.longitude.toFixed(6)},${center.latitude.toFixed(6)},${zoom.toFixed(2)}`
    const url = new URL(`https://api.mapbox.com/styles/v1/${username}/${styleId}/static/${overlay}${camera}/${width}x${height}@2x.webp`)
    url.searchParams.set('access_token', token)
    return url
  }

  let url = createUrl()
  while (url.href.length > MAX_MAPBOX_URL_LENGTH && selected.length) {
    selected.pop()
    url = createUrl()
  }
  if (url.href.length > MAX_MAPBOX_URL_LENGTH) {
    throw new Error('Mapbox Static Images URL exceeds the 8192 character limit')
  }

  return { url, includedPlaceIds: selected.map(place => place.id) }
}

const fetchPlaces = async (fetchImpl: FetchLike): Promise<CommunityMapPlace[]> => {
  let response: Response
  try {
    response = await fetchImpl(BERUBITCOIN_URL, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })
  } catch (error) {
    const detail = error instanceof Error
      ? `${error.name}: ${error.message}`
      : `non-Error rejection (${typeof error})`
    console.error(`[community-maps] BeruBitcoin fetch failed: ${detail}`)
    throw new Error('BeruBitcoin places request failed', { cause: error })
  }

  if (!response.ok) throw new Error(`BeruBitcoin places request failed with HTTP ${response.status}`)
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new Error('BeruBitcoin places response is not JSON')
  }

  const bytes = await readResponseBytes(response, MAX_JSON_BYTES)
  let payload: unknown
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes))
  } catch (error) {
    throw new Error('BeruBitcoin places response contains invalid JSON', { cause: error })
  }
  return parseBeruBitcoinPlaces(payload)
}

const fetchMapImage = async (fetchImpl: FetchLike, url: URL, slug: string): Promise<Uint8Array> => {
  let response: Response
  try {
    response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(15_000) })
  } catch {
    throw new Error(`Mapbox image request failed for ${slug}`)
  }

  if (!response.ok) throw new Error(`Mapbox image request failed for ${slug} with HTTP ${response.status}`)
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  if (!contentType.startsWith('image/webp')) {
    throw new Error(`Mapbox image response for ${slug} is not WebP`)
  }

  const bytes = await readResponseBytes(response, MAX_IMAGE_BYTES)
  if (!bytes.byteLength) throw new Error(`Mapbox image response for ${slug} is empty`)
  return bytes
}

const runWithConcurrency = async <T, R>(
  items: readonly T[],
  concurrency: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> => {
  const results = new Array<R>(items.length)
  let nextIndex = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++
      results[index] = await task(items[index]!)
    }
  }))
  return results
}

export const generateCommunityMaps = async ({
  token,
  communities,
  blob,
  style = DEFAULT_MAPBOX_STYLE,
  fetchImpl = fetch,
}: GenerateCommunityMapsOptions) => {
  const trimmedToken = token.trim()
  if (!trimmedToken) throw new Error('Mapbox access token is not configured')

  const places = await fetchPlaces(fetchImpl)
  const requests = communities.flatMap(community => COMMUNITY_MAP_VARIANTS.map(variant => ({ community, variant })))
  const images = await runWithConcurrency(requests, 4, async ({ community, variant }) => {
    const zoom = community.map.zoom ?? DEFAULT_ZOOM
    const center = { latitude: community.map.lat, longitude: community.map.lng }
    const selectedPlaces = selectPlacesForMap(places, center, zoom, variant.width, variant.height)
    const { url } = buildMapboxStaticUrl({
      center,
      places: selectedPlaces,
      token: trimmedToken,
      style,
      zoom,
      width: variant.width,
      height: variant.height,
    })
    return fetchMapImage(fetchImpl, url, `${community.slug}-${variant.name}`)
  })

  await Promise.all(requests.map(({ community, variant }, index) => blob.put(
    `community-maps/v1/${community.slug}-${variant.name}.webp`,
    images[index]!,
    {
      contentType: 'image/webp',
      customMetadata: { community: community.slug, variant: variant.name },
    },
  )))

  return { generated: communities.length, images: requests.length }
}
