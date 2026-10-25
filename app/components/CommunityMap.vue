<script setup lang="ts">
import geometry from '#shared/data/communityMapGeometry.json'
import { useDataCommunities } from '~/composables/content'
import {
  COMMUNITY_MAP_HEIGHT,
  COMMUNITY_MAP_WIDTH,
  centerCommunityMapOn,
  clampCommunityMapTransform,
  projectCommunityCoordinate,
  type CommunityMapTransform,
} from '~/utils/communityMap'

const { data, error } = await useDataCommunities()

const markers = computed(() => (data.value ?? []).flatMap((community) => {
  const points = community.homepage_map?.length
    ? community.homepage_map
    : community.map ? [{ label: community.title, ...community.map }] : []
  return points.map((point, index) => ({
    key: `${community.path}#${index}`,
    path: community.path,
    label: point.label,
    title: community.title,
    region: [community.region].flat().join(', '),
    ...projectCommunityCoordinate(point.lng, point.lat),
  }))
}))

const transform = reactive<CommunityMapTransform>({ scale: 1, x: 0, y: 0 })
const activeMarker = ref<string | null>(null)
const dragging = reactive({
  active: false,
  moved: false,
  pointerId: -1,
  startX: 0,
  startY: 0,
  originX: 0,
  originY: 0,
})
const pointers = new Map<number, { x: number, y: number }>()
const pinch = reactive({
  distance: 0,
  scale: 1,
  anchorX: 0,
  anchorY: 0,
})

const isZoomed = computed(() => transform.scale > 1.05)
const mapTransform = computed(() => `translate(${transform.x} ${transform.y}) scale(${transform.scale})`)
const mapContainer = useTemplateRef<HTMLElement>('mapContainer')
const mapSvg = useTemplateRef<SVGSVGElement>('mapSvg')
const { width: windowWidth, height: windowHeight } = useWindowSize()
const { width: mapContainerWidth } = useElementSize(mapContainer)
const { width: mapWidth } = useElementSize(mapSvg)
const isPortraitZoomed = computed(() => isZoomed.value && windowWidth.value < windowHeight.value)
const mapContainerHeight = computed(() => {
  if (!mapContainerWidth.value) return undefined
  return `${isPortraitZoomed.value ? windowHeight.value * 2 / 3 : mapContainerWidth.value * 7 / 12}px`
})
const svgUnitsPerPixel = computed(() => COMMUNITY_MAP_WIDTH / (mapWidth.value || COMMUNITY_MAP_WIDTH))
const markerRadius = computed(() => 7 * svgUnitsPerPixel.value)
const markerStroke = 3
const labelFontSize = computed(() => 17 * svgUnitsPerPixel.value)
const labelOffset = computed(() => 15 * svgUnitsPerPixel.value)
const markerTransform = (x: number, y: number) => `translate(${x * transform.scale + transform.x} ${y * transform.scale + transform.y})`
let centerMapTimer: ReturnType<typeof setTimeout> | undefined

watch(isPortraitZoomed, (portraitZoomed) => {
  if (!import.meta.client || !portraitZoomed) return
  clearTimeout(centerMapTimer)
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  centerMapTimer = setTimeout(() => {
    mapContainer.value?.scrollIntoView({
      behavior: reducedMotion ? 'auto' : 'smooth',
      block: 'center',
    })
  }, reducedMotion ? 0 : 1000)
})

onBeforeUnmount(() => clearTimeout(centerMapTimer))

const setTransform = (next: CommunityMapTransform) => Object.assign(transform, next)
const resetMap = () => setTransform({ scale: 1, x: 0, y: 0 })

const pointFromClientPosition = (svg: SVGSVGElement, clientX: number, clientY: number) => {
  const matrix = svg.getScreenCTM()
  if (!matrix) return { x: COMMUNITY_MAP_WIDTH / 2, y: COMMUNITY_MAP_HEIGHT / 2 }

  const point = svg.createSVGPoint()
  point.x = clientX
  point.y = clientY
  return point.matrixTransform(matrix.inverse())
}

const pointFromEvent = (event: MouseEvent) => pointFromClientPosition(
  event.currentTarget as SVGSVGElement,
  event.clientX,
  event.clientY,
)

const toggleZoom = (event: MouseEvent) => {
  if (dragging.moved) {
    dragging.moved = false
    return
  }
  if (isZoomed.value) {
    resetMap()
    return
  }

  const point = pointFromEvent(event)
  setTransform(centerCommunityMapOn(point.x, point.y))
}

const activateMarker = (event: MouseEvent, marker: (typeof markers.value)[number]) => {
  if (isZoomed.value) return
  event.preventDefault()
  activeMarker.value = marker.key
  setTransform(centerCommunityMapOn(marker.x, marker.y))
}

const startPan = (event: PointerEvent) => {
  if (!isZoomed.value || (event.target as Element).closest('a')) return
  const svg = event.currentTarget as SVGSVGElement
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
  svg.setPointerCapture(event.pointerId)
  dragging.active = true
  if (pointers.size === 1) {
    dragging.moved = false
    dragging.pointerId = event.pointerId
    dragging.startX = event.clientX
    dragging.startY = event.clientY
    dragging.originX = transform.x
    dragging.originY = transform.y
    return
  }

  if (pointers.size === 2) {
    const [first, second] = [...pointers.values()]
    if (!first || !second) return
    const midpointX = (first.x + second.x) / 2
    const midpointY = (first.y + second.y) / 2
    const midpoint = pointFromClientPosition(svg, midpointX, midpointY)
    pinch.distance = Math.hypot(first.x - second.x, first.y - second.y)
    pinch.scale = transform.scale
    pinch.anchorX = (midpoint.x - transform.x) / transform.scale
    pinch.anchorY = (midpoint.y - transform.y) / transform.scale
    dragging.moved = true
  }
}

const movePan = (event: PointerEvent) => {
  if (!dragging.active || !pointers.has(event.pointerId)) return
  const svg = event.currentTarget as SVGSVGElement
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })

  if (pointers.size === 1 && event.pointerId === dragging.pointerId) {
    const deltaX = event.clientX - dragging.startX
    const deltaY = event.clientY - dragging.startY
    if (Math.hypot(deltaX, deltaY) > 3) dragging.moved = true

    const matrix = svg.getScreenCTM()
    if (!matrix) return
    setTransform(clampCommunityMapTransform({
      scale: transform.scale,
      x: dragging.originX + deltaX / matrix.a,
      y: dragging.originY + deltaY / matrix.d,
    }))
    return
  }

  if (pointers.size === 2) {
    const [first, second] = [...pointers.values()]
    if (!first || !second) return
    const midpointX = (first.x + second.x) / 2
    const midpointY = (first.y + second.y) / 2
    const midpoint = pointFromClientPosition(svg, midpointX, midpointY)
    const distance = Math.hypot(first.x - second.x, first.y - second.y)
    if (!pinch.distance) return

    const scale = Math.max(1, Math.min(5, pinch.scale * distance / pinch.distance))
    setTransform(clampCommunityMapTransform({
      scale,
      x: midpoint.x - pinch.anchorX * scale,
      y: midpoint.y - pinch.anchorY * scale,
    }))
  }
}

const stopPan = (event: PointerEvent) => {
  if (!pointers.has(event.pointerId)) return
  pointers.delete(event.pointerId)
  if ((event.currentTarget as SVGSVGElement).hasPointerCapture(event.pointerId)) {
    ;(event.currentTarget as SVGSVGElement).releasePointerCapture(event.pointerId)
  }

  if (!pointers.size) {
    dragging.active = false
    dragging.pointerId = -1
    if (transform.scale <= 1.05) resetMap()
    return
  }

  const [remainingPointerId, remaining] = pointers.entries().next().value as [number, { x: number, y: number }]
  dragging.pointerId = remainingPointerId
  dragging.startX = remaining.x
  dragging.startY = remaining.y
  dragging.originX = transform.x
  dragging.originY = transform.y
}
</script>

<template>
  <section
    id="mapa"
    aria-labelledby="community-map-heading"
    tabindex="-1"
    class="relative z-10 scroll-mt-[calc(var(--ui-header-height)+1rem)]"
  >
    <UContainer class="text-center text-inverted">
      <h2 id="community-map-heading" class="text-xl text-primary font-semibold sm:text-3xl">
        Najdi svou komunitu
      </h2>
      <p>Jsme v {{ markers.length }} městech po celém Česku.</p>

      <p v-if="error" role="alert" class="mt-8 text-white/75">
        Mapu komunit se nepodařilo načíst. Zkus stránku obnovit.
      </p>
    </UContainer>

    <div
      v-if="!error"
      ref="mapContainer"
      class="community-map-container relative mt-4 md:mt-12 w-full overflow-hidden"
      :style="{ height: mapContainerHeight }"
    >
      <svg
        ref="mapSvg"
        :viewBox="`0 0 ${COMMUNITY_MAP_WIDTH} ${COMMUNITY_MAP_HEIGHT}`"
        preserveAspectRatio="xMidYMid slice"
        aria-labelledby="community-map-title community-map-description"
        class="community-map block size-full select-none"
        :class="{ 'is-panning': dragging.active, 'is-zoomed': isZoomed }"
        @click="toggleZoom"
        @pointerdown="startPan"
        @pointermove="movePan"
        @pointerup="stopPan"
        @pointercancel="stopPan"
      >
        <title id="community-map-title">Mapa bitcoinových komunit v Česku</title>
        <desc id="community-map-description">
          Kliknutím mapu přiblížíš nebo oddálíš. Na přiblížené mapě ji jedním prstem posuneš a dvěma prsty změníš přiblížení. Oranžové body a jejich názvy odkazují na místní komunity.
        </desc>

        <g :transform="mapTransform" class="map-layer">
          <template v-for="country in geometry.countries" :key="country.id">
            <path
              :d="country.path"
              class="country-shape"
              :class="country.id === 'czechia' ? 'country-czechia' : 'country-neighbour'"
              vector-effect="non-scaling-stroke"
            />
            <a
              v-if="country.href"
              :href="country.href"
              target="_blank"
              rel="noopener noreferrer"
              :aria-label="`${country.label}, komunitní web. Otevře se v novém okně.`"
              class="country-link"
              @click.stop
            >
              <text
                :x="country.labelPosition.x"
                :y="country.labelPosition.y"
                class="country-label"
                :font-size="20 / transform.scale"
                :transform="country.labelRotation ? `rotate(${country.labelRotation} ${country.labelPosition.x} ${country.labelPosition.y})` : undefined"
                text-anchor="middle"
              >{{ country.label }}</text>
            </a>
            <text
              v-else
              :x="country.labelPosition.x"
              :y="country.labelPosition.y"
              class="country-label country-label-czechia"
              :font-size="18 / transform.scale"
              :transform="country.labelRotation ? `rotate(${country.labelRotation} ${country.labelPosition.x} ${country.labelPosition.y})` : undefined"
              text-anchor="middle"
            >{{ country.label }}</text>
          </template>

          <path
            v-for="region in geometry.regions"
            :key="region.name"
            :d="region.path"
            class="region-outline"
            vector-effect="non-scaling-stroke"
          />

        </g>

        <a
          v-for="marker in markers"
          :key="marker.key"
          :href="marker.path"
          :aria-label="`${marker.label === marker.title ? marker.title : `${marker.label} – ${marker.title}`}, ${marker.region}. V základním pohledu přiblíží mapu, v přiblíženém otevře komunitu.`"
          :transform="markerTransform(marker.x, marker.y)"
          class="community-marker"
          @mouseenter="activeMarker = marker.key"
          @mouseleave="activeMarker = null"
          @focus="activeMarker = marker.key"
          @blur="activeMarker = null"
          @click.stop="activateMarker($event, marker)"
        >
            <circle
              cx="0"
              cy="0"
              :r="markerRadius"
              :stroke-width="markerStroke"
              class="marker-dot"
              vector-effect="non-scaling-stroke"
            />
            <text
              x="0"
              :y="-labelOffset"
              :font-size="labelFontSize"
              class="marker-label"
              :class="{ 'is-visible': isZoomed || activeMarker === marker.key }"
              text-anchor="middle"
            >{{ marker.label }}</text>
        </a>
      </svg>
    </div>
  </section>
</template>

<style scoped>
.community-map {
  cursor: zoom-in;
  touch-action: pan-y;
}

.community-map-container {
  aspect-ratio: 12 / 7;
  transition: height 1000ms cubic-bezier(0.22, 1, 0.36, 1);
}

.community-map.is-zoomed {
  cursor: grab;
  touch-action: none;
}

.community-map.is-panning {
  cursor: grabbing;
}

.map-layer {
  transition: transform 1000ms cubic-bezier(0.22, 1, 0.36, 1);
}

.community-marker {
  transition: transform 1000ms cubic-bezier(0.22, 1, 0.36, 1);
}

.community-map.is-panning .map-layer,
.community-map.is-panning .community-marker {
  transition: none;
}

.country-shape {
  stroke: rgb(255 255 255 / 0.9);
  stroke-width: 1.5;
}

.country-neighbour {
  fill: transparent;
}

.country-czechia {
  fill: rgb(17 24 39 / 0.68);
  stroke-width: 2.25;
}

.country-label,
.marker-label {
  fill: white;
  paint-order: stroke;
  stroke: rgb(17 24 39 / 0.95);
  stroke-linejoin: round;
  stroke-width: 5px;
}

.country-label {
  cursor: pointer;
  opacity: 0.5;
}

.country-label-czechia {
  pointer-events: none;
}

.region-outline {
  fill: none;
  pointer-events: none;
  stroke: rgb(255 255 255 / 0.42);
  stroke-width: 0.65;
}

.marker-dot {
  fill: var(--ui-color-primary-500);
  stroke: rgb(17 24 39 / 0.9);
  transition: fill 150ms ease;
}

.community-marker:hover .marker-dot,
.community-marker:focus-visible .marker-dot,
.community-marker:hover .marker-label,
.community-marker:focus-visible .marker-label {
  fill: var(--ui-color-primary-300);
}

.community-marker:focus-visible {
  outline: none;
}

.marker-label {
  cursor: pointer;
  font-weight: 600;
  opacity: 0;
  pointer-events: none;
  stroke-width: 4px;
  transition: opacity 150ms ease;
}

.marker-label.is-visible {
  opacity: 1;
  pointer-events: auto;
}

@media (prefers-reduced-motion: reduce) {
  .community-map-container,
  .map-layer,
  .community-marker,
  .marker-label,
  .marker-dot {
    transition: none;
  }
}
</style>
