<script setup lang="ts">
import type { TabsItem } from '@nuxt/ui'

type VariantValue = 'beginners' | 'advanced'

const variants: Array<TabsItem & { value: VariantValue, accent: string, heading: string }> = [
  {
    label: 'Začátečníci',
    value: 'beginners',
    accent: 'Začni otázkou.',
    heading: 'Ne tříhodinovým videem.',
  },
  {
    label: 'Pokročilí',
    value: 'advanced',
    accent: 'Nejlepší diskuse',
    heading: 'se nedějí online.',
  },
]

const activeVariant = ref<VariantValue>('beginners')
const activeContent = computed(() => variants.find(variant => variant.value === activeVariant.value) ?? variants[0]!)

useHead({ title: 'Najdi svou bitcoinovou komunitu' })
</script>

<template>
  <section class="homepage-discovery relative overflow-hidden">
    <UPageHero
      as="div"
      data-homepage-hero
      description="Jednadvacet je česká bitcoinová komunita. Ve městech po Česku se scházíme u piva, na pikniku s dětmi nebo na přednášce."
      class="relative z-10 scroll-mt-[calc(var(--ui-header-height)+1rem)]"
      :ui="{
        container: 'min-h-128 items-center py-26 text-center sm:py-24 lg:py-32',
        wrapper: 'mx-auto max-w-3xl text-center',
        header: 'space-y-6',
        headline: 'mt-8 flex justify-center',
        title: 'mt-8 mb-8 lg:my-3 text-3xl font-semibold leading-tight text-inverted text-pretty tracking-normal',
        description: 'mx-auto mt-0 max-w-prose text-base leading-6 text-inverted',
        footer: 'mt-6',
        links: 'justify-center',
      }"
    >

      <template #top>
        <NuxtImg
          src="/images/app/pub-meetup.jpeg"
          alt=""
          width="1920"
          height="1440"
          preload
          class="absolute inset-0 w-full h-full object-cover object-[30%] -z-20"
          aria-hidden="true"
        />
        <div class="absolute inset-0 -z-10 bg-linear-to-b from-black/40 via-black/60 to-neutral-900" aria-hidden="true" />
      </template>

      <template #headline>
        <UTabs
          v-model="activeVariant"
          :items="variants"
          :content="false"
          variant="pill"
          class="w-fit max-w-full"
          :ui="{
            list: 'w-fit max-w-full bg-white/15 ring-1 ring-white/15 backdrop-blur-sm',
            trigger: 'min-h-9 px-3 sm:min-h-11 sm:px-4',
            label: 'whitespace-normal text-xs font-semibold text-inverted sm:text-sm',
          }"
        />
      </template>

      <template #title>
        <div class="mb-1 text-primary">{{ activeContent.accent }}</div>
        <div class="">{{ activeContent.heading }}</div>
      </template>

    </UPageHero>

    <CommunityMap />
  </section>
</template>

<style scoped>
.homepage-discovery {
  background-color: #111827;
  --ui-text-inverted: #fff;
}
</style>
