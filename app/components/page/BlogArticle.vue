<script setup lang="ts">
import type { BlogArticlesCollectionItem } from '@nuxt/content'

defineProps<{
  article: BlogArticlesCollectionItem
}>()

const config = useRuntimeConfig()
</script>

<template>

  <Head>
    <Title>{{ article.title }}</Title>
    <Meta name="description" :content="article.description" />
    <Meta property="og:title" :content="article.title" />
    <Meta property="og:description" :content="article.description" />
    <Meta property="og:image" :content="article.thumbnail" />
    <Meta property="og:type" content="article" />
  </Head>

  <NuxtImg :src="article.thumbnail" :alt="article.title"
    sizes="xs:100vw sm:100vw md:100vw lg:100vw xl:100vw xxl:100vw" width="1280" height="720" format="webp" :quality="80"
    class="mt-[calc(-1*var(--ui-header-height))] -mb-10 w-full aspect-video max-h-[60vh] object-cover" />
  <div class="bg-default rounded-t-4xl h-20 -mb-18 z-40 relative" />

  <UContainer class="relative z-40">
    <UPage>
      <UPageHeader :title="article.title">
        <template v-if="article.categories?.length" #description>
          <div class="flex flex-wrap items-center gap-2 mb-5">
            <CategoriesBadges :categories-stems="article.categories" />
            <NuxtTime v-if="article.published" :datetime="article.published" />
          </div>
          {{ article.description }}
        </template>
      </UPageHeader>

      <UContentToc :links="article.body?.toc?.links" :ui="{ root: 'lg:hidden' }" />

      <UPageBody>
        <ContentRenderer :value="article" class="prose dark:prose-invert" />

        <USeparator v-if="article.authors?.length" class="my-6" />

        <div v-if="article.authors?.length" class="authors space-y-4">
          <AuthorBlock v-for="authorId in article.authors" :key="authorId" :author-id="authorId" />
        </div>
      </UPageBody>

      <template #right>
        <UContentToc :links="article.body?.toc?.links" :ui="{ root: 'max-lg:hidden' }" />
      </template>

      <template #left>
        <div />
      </template>
    </UPage>
  </UContainer>
</template>
