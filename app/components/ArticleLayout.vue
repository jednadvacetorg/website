<script setup lang="ts">
import type { BlogArticlesCollectionItem, PodcastCollectionItem } from '@nuxt/content'

const props = defineProps<{
  item: BlogArticlesCollectionItem | PodcastCollectionItem
}>()

const ogImage = buildOgImageCall({
  title: props.item.title,
  image: props.item.thumbnail,
  podcast: props.item.path.startsWith('/podcast/'),
})

const podcastArtwork = { key: 'podcast', width: 1400, height: 1400, extension: 'png' as const, props: { ...ogImage.sharedProps, format: 'podcast' as const } }
defineOgImage('Article', ogImage.sharedProps, [
  ...ogImage.publicOptions,
  ...(props.item.audio && !props.item.cover ? [podcastArtwork] : []),
])
const cover = computed(() => props.item.cover || getOgImagePath(props.item.path, {
  ...podcastArtwork,
  component: 'Article',
}).path)
</script>

<template>
  <Head>
    <Title>{{ item.title }}</Title>
    <Meta name="description" :content="item.description" />
    <Meta property="og:title" :content="item.title" />
    <Meta property="og:description" :content="item.description" />
    <Meta property="og:type" content="article" />
  </Head>

  <NuxtImg :src="item.thumbnail" :alt="item.title"
    sizes="xs:100vw sm:100vw md:100vw lg:100vw xl:100vw xxl:100vw" width="1280" height="720" format="webp" :quality="80"
    class="mt-[calc(-1*var(--ui-header-height))] -mb-10 w-full aspect-video max-h-[60vh] object-cover" />
  <div class="bg-default rounded-t-4xl h-20 -mb-18 z-40 relative" />

  <UContainer class="relative z-40">
    <UPage>
      <slot name="header" :cover="cover" />

      <UContentToc :links="item.body?.toc?.links" :ui="{ root: 'lg:hidden' }" />

      <UPageBody>
        <ContentRenderer :value="item" class="prose dark:prose-invert" />

        <USeparator v-if="item.authors?.length" class="my-6" />
        <div v-if="item.authors?.length" class="authors space-y-4">
          <PersonBlock v-for="authorSlug in item.authors" :key="authorSlug" :slug="authorSlug" />
        </div>
      </UPageBody>

      <template #right>
        <UContentToc :links="item.body?.toc?.links" :ui="{ root: 'max-lg:hidden' }" />
      </template>
      <template #left>
        <div />
      </template>
    </UPage>
  </UContainer>
</template>
