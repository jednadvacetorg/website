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
  // and logo are enlarged by 70% compared to a plain 16:9 layout.
  youtube: { padding: 80, titleSize: 143, titleMaxWidth: 1200, logoHeight: 122 },
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
      <div :style="{ maxWidth: `${style.titleMaxWidth}px` }">
        <h1
          :style="{
            color: '#ffffff',
            fontSize: `${style.titleSize}px`,
            lineHeight: 1.15,
            fontWeight: 800,
            fontStyle: 'normal',
            textTransform: 'uppercase',
            textShadow: '0 2px 24px rgba(0,0,0,0.6)',
          }"
        >
          {{ title }}
        </h1>
      </div>

      <div :style="layout === 'host' ? { position: 'absolute', bottom: `${style.padding}px`, left: `${style.padding}px` } : undefined">
        <img
          src="/images/app/logo-dark.svg"
          alt="Jednadvacet"
          :style="{ height: `${style.logoHeight}px` }"
        />
      </div>
    </div>
  </div>
</template>
