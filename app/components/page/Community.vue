<script setup lang="ts">
import type { CommunitiesCollectionItem } from '@nuxt/content'

const { community } = defineProps<{
  community: CommunitiesCollectionItem
}>()

const communityMapSlug = computed(() => community.path
  .replace(/^\/+|\/+$/g, '')
  .replaceAll('/', '-'))
const communityMapSrc = (variant: 'sm' | 'md' | 'lg') => import.meta.dev
  ? `/api/community-maps/${communityMapSlug.value}-${variant}`
  : `https://files.jednadvacet.org/community-maps/v1/${communityMapSlug.value}-${variant}.webp`
</script>

<template>
  <UPageHero
    headline="Bitcoinová komunita"
    :title="community.title"
    orientation="horizontal"
    :ui="{
      root: community.map ? 'relative isolate overflow-hidden bg-muted' : undefined,
      container: 'relative z-10 pt-12 pb-20 sm:pt-16 lg:pb-16',
      wrapper: 'max-w-xl',
      title: community.map ? 'text-pretty text-white' : 'text-pretty',
      description: community.map ? 'text-white/80' : undefined,
    }"
  >
    <template v-if="community.map" #top>
      <picture
        aria-hidden="true"
        class="absolute inset-0"
      >
        <source media="(min-width: 1024px)" :srcset="communityMapSrc('lg')">
        <source media="(min-width: 768px)" :srcset="communityMapSrc('md')">
        <img
          :src="communityMapSrc('sm')"
          alt=""
          class="size-full object-cover object-center"
          decoding="async"
          fetchpriority="high"
        >
      </picture>
      <div aria-hidden="true" class="absolute inset-0 bg-linear-to-r from-black/75 to-black/30" />
    </template>

    <template #links>
      <UButton
        v-if="community.signal_group"
        :to="community.signal_group"
        target="_blank"
        rel="noopener noreferrer"
        label="Připoj se do Signal skupiny"
        trailing-icon="i-lucide-external-link"
        class="text-black"
      />
    </template>

    <template v-if="community.map" #bottom>
      <p class="absolute right-3 bottom-2 z-10 text-right text-xs text-white opacity-50">
        ©
        <ULink class="text-white/60 underline" to="https://www.mapbox.com/about/maps/" target="_blank" rel="noopener noreferrer">Mapbox</ULink>,
        © <ULink class="text-white/60 underline" to="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</ULink>,
        <ULink class="text-white/60 underline" to="https://btcmap.org" target="_blank" rel="noopener noreferrer">BTC Map</ULink>.
      </p>
    </template>
  </UPageHero>

  <UContainer v-if="community.body || community.organizers?.length" class="pb-12">
    <div v-if="community.body" class="prose dark:prose-invert">
      <ContentRenderer :value="community" />
    </div>

    <USeparator v-if="community.organizers?.length" class="my-6" />

    <section v-if="community.organizers?.length">
      <h2 class="text-xl font-semibold mb-4">Organizátoři</h2>
      <div class="divide-y divide-default">
        <PersonBlock v-for="organizerSlug in community.organizers" :key="organizerSlug" :slug="organizerSlug" />
      </div>
    </section>
  </UContainer>
</template>
