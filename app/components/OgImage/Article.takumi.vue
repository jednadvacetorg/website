<script setup lang="ts">
import { computed } from 'vue'
import type { OgImageFormat, OgImageLayout } from '~/utils/ogImage'

const props = withDefaults(defineProps<{
  title: string
  image: string
  layout?: OgImageLayout
  format?: OgImageFormat
}>(), {
  layout: 'default',
  format: 'landscape',
})

interface FormatStyle {
  padding: number
  titleSize: number
  titleMaxWidth: number
  logoHeight: number
}

const formatStyles: Record<OgImageFormat, FormatStyle> = {
  landscape: { padding: 64, titleSize: 64, titleMaxWidth: 760, logoHeight: 56 },
  square: { padding: 48, titleSize: 48, titleMaxWidth: 640, logoHeight: 48 },
  portrait: { padding: 56, titleSize: 56, titleMaxWidth: 880, logoHeight: 52 },
  // Stories display fullscreen on phones, so the title is doubled for legibility.
  story: { padding: 56, titleSize: 112, titleMaxWidth: 880, logoHeight: 52 },
  // YouTube thumbnails are mostly seen at search-result size, so the title
  // is enlarged by 70% compared to a plain 16:9 layout. The logo stays
  // the same size in every format.
  youtube: { padding: 80, titleSize: 143, titleMaxWidth: 1200, logoHeight: 72 },
}

const style = computed<FormatStyle>(() => {
  const base = formatStyles[props.format]
  return {
    padding: base.padding,
    titleSize: base.titleSize * (props.layout === 'host' ? 1.15 : 1),
    titleMaxWidth: base.titleMaxWidth,
    logoHeight: base.logoHeight,
  }
})

const contentJustify = computed(() => props.layout === 'host' ? 'center' : 'space-between')

// Soft contrast shadows: stacked blurred halos at partial opacity, so text
// and logo stay legible over a bright photographic background without a hard
// edge.
//
// Takumi drops text-shadow/filter on nodes nested in a plain block container,
// so the title carries max-width itself (no wrapper div) and the logo wrapper
// below is always a flex container. Verified against @takumi-rs/core 2.14.
const titleTextShadow = '0 2px 12px rgba(0,0,0,0.55), 0 4px 32px rgba(0,0,0,0.45), 0 8px 80px rgba(0,0,0,0.35)'
const logoDropShadow = 'drop-shadow(0 2px 12px rgba(0,0,0,0.55)) drop-shadow(0 4px 32px rgba(0,0,0,0.4))'
</script>

<template>
  <div style="position: relative; width: 100%; height: 100%; overflow: hidden; background-color: #111827; display: flex; font-family: 'Ubuntu Sans';">
    <img
      :src="image"
      :alt="title"
      style="position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover;"
    />

    <div style="position: absolute; inset: 0; background-image: linear-gradient(to bottom, rgba(0,0,0,0.45) 0%, rgba(0,0,0,0.15) 40%, rgba(0,0,0,0.15) 55%, rgba(0,0,0,0.7) 100%);" />

    <div
      :style="{ position: 'relative', display: 'flex', flexDirection: 'column', width: '100%', height: '100%', padding: `${style.padding}px`, justifyContent: contentJustify }"
    >
      <h1
        :style="{
          color: '#ffffff',
          fontSize: `${style.titleSize}px`,
          lineHeight: 1.15,
          fontWeight: 800,
          fontStyle: 'normal',
          textTransform: 'uppercase',
          maxWidth: `${style.titleMaxWidth}px`,
          textShadow: titleTextShadow,
        }"
      >
        {{ title }}
      </h1>

      <div :style="layout === 'host' ? { display: 'flex', position: 'absolute', bottom: `${style.padding}px`, left: `${style.padding}px` } : { display: 'flex' }">
        <img
          src="/images/app/logo-dark.svg"
          alt="Jednadvacet"
          :style="{ height: `${style.logoHeight}px`, filter: logoDropShadow }"
        />
      </div>
    </div>
  </div>
</template>
