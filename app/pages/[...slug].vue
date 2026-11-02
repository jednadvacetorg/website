<script setup lang="ts">
import type { CommunitiesCollectionItem, PagesCollectionItem } from '@nuxt/content'

type PageResult =
  | { type: 'page'; item: PagesCollectionItem }
  | { type: 'community'; item: CommunitiesCollectionItem }

const route = useRoute()

const { data: result } = await useAsyncData('page-' + route.path, async (): Promise<PageResult | null> => {
  const page = await queryCollection('pages').path(route.path).first()
  if (page) return { type: 'page', item: page }

  const community = await queryCollection('communities').path(route.path).first()
  if (community && !community.hidden) return { type: 'community', item: community }

  return null
})

if (!result.value) {
  throw createError({ statusCode: 404, statusMessage: 'Page not found', fatal: true })
}

const site = useSiteConfig()
const ogImage = computed(() => {
  if (result.value?.type !== 'page' || !result.value.item.ogImage) return undefined
  return new URL(result.value.item.ogImage, site.url).href
})

useSeoMeta({
  ogImage: () => ogImage.value,
  twitterImage: () => ogImage.value,
  twitterCard: () => ogImage.value ? 'summary_large_image' : undefined,
})

</script>

<template>
  <Head>
    <Title>{{ result!.item.title }}</Title>
    <Meta property="og:title" :content="result!.item.title" />
    <Meta property="og:type" content="website" />
  </Head>

  <ContentRenderer
    v-if="result!.type === 'page'"
    :value="result!.item"
  />
  <PageCommunity
    v-else-if="result!.type === 'community'"
    :community="result!.item"
  />
</template>
