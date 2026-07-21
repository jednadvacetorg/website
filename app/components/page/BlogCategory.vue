<script setup lang="ts">
import type { BlogCategoriesCollectionItem } from '@nuxt/content'

const props = defineProps<{
  category?: BlogCategoriesCollectionItem
}>()

const config = useRuntimeConfig()

const categoryStem = computed(() => {
  return props.category?.path?.split('/').pop()
})

const { data: articles } = await useAsyncData(() => `blog-articles-list-${categoryStem.value || 'all'}`, async () => {
  let query = queryCollection('blogArticles')
    .order('id', 'DESC')
    .select('path', 'title', 'description', 'thumbnail', 'published', 'categories')

  if (categoryStem.value) {
    query = query.where('categories', 'LIKE', `%${categoryStem.value}%`)
  }

  return query.all()
})

const categoryTitle = computed(() => {
  return props.category?.title || 'Blog'
})

const categoryDescription = computed(() => {
  if (!articles.value?.length) return undefined
  return articles.value.map(a => a.title).join(', ')
})
</script>

<template>

  <Head>
    <Title>{{ categoryTitle }}</Title>
    <Meta name="description" :content="categoryDescription" />
    <Meta property="og:title" :content="categoryTitle" />
    <Meta property="og:description" :content="categoryDescription" />
    <Meta property="og:type" content="website" />
  </Head>

  <div class="max-w-3xl mx-auto py-8 px-4">
    <header class="mb-8">
      <UButton v-if="categoryStem" color="neutral" variant="link"
        leading-icon="i-streamline-interface-arrows-left-arrow-keyboard-left" to="/blog">Všechny články</UButton>

      <h1 class="text-4xl font-bold">{{ categoryTitle }}</h1>

      <div v-if="!category" class="flex flex-wrap gap-2 my-10">
        <CategoriesBadges class="mt-4" />
      </div>
    </header>

    <div v-if="category?.body" class="mb-8 prose dark:prose-invert">
      <ContentRenderer :value="category" />
    </div>

    <UBlogPosts v-if="articles?.length" orientation="vertical">
      <UBlogPost v-for="article in articles" :key="article.path" :title="article.title"
        :description="article.description"
        :image="article.thumbnail
          ? { src: article.thumbnail, sizes: 'xs:100vw sm:320px', width: 480, height: 270, format: 'webp', loading: 'lazy' }
          : 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAAD0lEQVR4AQEEAPv/AMzMzATMAmVMDHrmAAAAAElFTkSuQmCC'"
        :date="article.published" :to="article.path" orientation="horizontal" variant="naked"
        :ui="{ root: 'overflow-visible', header: 'border border-gray-600/10', meta: 'flex-wrap' }">
        <template #badge>
          <CategoriesBadges v-if="article.categories" :categories-stems="article.categories" size="xs" disabled />
        </template>
      </UBlogPost>
    </UBlogPosts>
    <p v-else class="text-center text-gray-500 py-8">Žádné články</p>
  </div>
</template>
