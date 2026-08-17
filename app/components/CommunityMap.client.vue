<script setup lang="ts">
import type { CommunitiesCollectionItem } from '@nuxt/content'
import czSvgRaw from '~/assets/maps/Cesko-kraje.svg?raw'

defineProps<{
  communities: CommunitiesCollectionItem[]
}>()

// Přebarvení + rozšíření viewBoxu tak, aby zobrazoval celý obsah
// (původní transform matrix posouvá obsah na x:-434, y:-354 → oříznuté rohy)
const NEW_VIEWBOX = '-450 -360 4400 2900'

const styledSvg = czSvgRaw
  .replace('viewBox="0 0 3508 2480.4"', `viewBox="${NEW_VIEWBOX}"`)
  .replace(
    '.str1 {stroke:#007CC3;stroke-width:6.25062;stroke-linejoin:bevel}',
    '.str1 {stroke:#f97316;stroke-width:6.25062;stroke-linejoin:bevel;stroke-opacity:0.35}'
  )
  .replace(
    '.str0 {stroke:#4D485B;stroke-width:8.33416;stroke-linejoin:bevel}',
    '.str0 {stroke:#f97316;stroke-width:8.33416;stroke-linejoin:bevel;stroke-opacity:0.7}'
  )
  .replace('.fil0 {fill:#DEDEDD}', '.fil0 {fill:#18120e}')
  .replace(
    'style="stroke:#ffffff;fill:#999298;fill-opacity:1"',
    'style="stroke:#f97316;stroke-opacity:0.7;fill:#18120e;fill-opacity:1"'
  )

// Přímá lineární projekce do SVG souřadnic — kalibrováno z Praha + Brno
// Cheb (12.37°E) → x≈0, Třinec (18.67°E) → x≈4400 (celá šířka viewBoxu = 701px)
const X_SCALE = 4400 / (18.67 - 12.37)  // 698.4
const X_OFFSET = -X_SCALE * 12.37
const Y_SCALE = -622.7 * (X_SCALE / 464.1)
const Y_OFFSET = 32281.6 * (X_SCALE / 464.1)

function project(lat: number, lng: number): [number, number] {
  return [X_SCALE * lng + X_OFFSET, Y_SCALE * lat + Y_OFFSET]
}

const hovered = ref<string | null>(null)
</script>

<template>
  <div class="relative w-full h-full rounded-xl overflow-hidden">
    <!-- Mapa krajů -->
    <div v-html="styledSvg" class="w-full h-full [&>svg]:w-full [&>svg]:h-full" />

    <!-- Vrstva s tečkami měst — stejný viewBox jako mapa -->
    <svg
      class="absolute inset-0 w-full h-full"
      :viewBox="NEW_VIEWBOX"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <filter id="cm-glow">
          <feGaussianBlur stdDeviation="25" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>

      <g id="city-dots">
        <template v-for="c in communities" :key="c.path">
          <template v-if="c.map">
            <circle
              :cx="project(c.map.lat, c.map.lng)[0]"
              :cy="project(c.map.lat, c.map.lng)[1]"
              r="63"
              fill="#f97316"
              fill-opacity="0.12"
              filter="url(#cm-glow)"
            />
            <circle
              :cx="project(c.map.lat, c.map.lng)[0]"
              :cy="project(c.map.lat, c.map.lng)[1]"
              r="31"
              fill="#f97316"
              :fill-opacity="hovered === c.path ? 1 : 0.8"
              :stroke="hovered === c.path ? '#fff' : 'none'"
              stroke-width="13"
              class="cursor-pointer"
              @mouseenter="hovered = c.path"
              @mouseleave="hovered = null"
            />
            <g v-if="hovered === c.path">
              <rect
                :x="project(c.map.lat, c.map.lng)[0] + 45"
                :y="project(c.map.lat, c.map.lng)[1] - 95"
                :width="c.title.length * 50 + 80"
                height="110"
                rx="16"
                fill="#1a1208"
                stroke="#f97316"
                stroke-width="8"
                stroke-opacity="0.7"
              />
              <text
                :x="project(c.map.lat, c.map.lng)[0] + 85"
                :y="project(c.map.lat, c.map.lng)[1] - 22"
                fill="white"
                font-size="75"
                font-family="sans-serif"
                font-weight="500"
              >{{ c.title }}</text>
            </g>
          </template>
        </template>
      </g>
    </svg>
  </div>
</template>
