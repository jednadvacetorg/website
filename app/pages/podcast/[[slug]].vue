<script setup lang="ts">
const { path, params: { slug } } = useRoute()

const { data: episode } = await useAsyncData(`podcast-${path}`, () => {
  return slug ? queryCollection('podcast').path(path).first() : Promise.resolve(null)
})

if (slug && !episode.value) {
  throw createError({ statusCode: 404, statusMessage: 'Page not found', fatal: true })
}

const { data: episodes } = await useAsyncData('podcast-list', () => {
  return slug ? Promise.resolve([]) : queryCollection('podcast').order('id', 'DESC')
    .select('path', 'title', 'description', 'thumbnail', 'published', 'categories').all()
})

useHead({
  link: [{ rel: 'alternate', type: 'application/rss+xml', title: 'Jednadvacet podcast', href: '/podcast.xml' }],
})
</script>

<template>
  <ArticleLayout v-if="episode" :item="episode">
    <template #hero>
      <YoutubePlayer :url="episode.video" :title="episode.title" hero />
    </template>
    <template #header="{ cover }">
      <UPageHeader :title="episode.title">
        <template #description>
          <div v-if="episode.categories?.length || episode.published" class="flex flex-wrap items-center gap-2 mb-5">
            <CategoriesBadges v-if="episode.categories?.length" :categories-stems="episode.categories" />
            <NuxtTime v-if="episode.published" :datetime="episode.published" />
          </div>
          {{ episode.description }}
        </template>
      </UPageHeader>
      <AudioPlayer :src="episode.audio" :title="episode.title" :cover="cover" />
    </template>
  </ArticleLayout>

  <UContainer v-else class="max-w-3xl py-8">
    <Head>
      <Title>Podcast</Title>
      <Meta name="description" content="Rozhovory z bitcoinové komunity a audioverze článků Jednadvacet." />
      <Meta property="og:title" content="Podcast" />
      <Meta property="og:type" content="website" />
    </Head>
    <UPageHeader title="Podcast">
      <template #links>
        <PodcastFollowLinks />
      </template>
    </UPageHeader>
    <UPageBody>
      <UBlogPosts v-if="episodes?.length" orientation="vertical">
        <UBlogPost v-for="item in episodes" :key="item.path" :title="item.title" :description="item.description"
          :image="{ src: item.thumbnail, sizes: 'xs:100vw sm:320px', width: 480, height: 270, format: 'webp', loading: 'lazy' }"
          :date="item.published" :to="item.path" orientation="horizontal" variant="naked"
          :ui="{ root: 'overflow-visible', header: 'border border-muted', meta: 'flex-wrap' }">
          <template #badge>
            <CategoriesBadges v-if="item.categories?.length" :categories-stems="item.categories" size="xs" disabled />
          </template>
        </UBlogPost>
      </UBlogPosts>
      <p v-else class="text-muted">Zatím tu nejsou žádné epizody.</p>
    </UPageBody>
  </UContainer>
</template>
