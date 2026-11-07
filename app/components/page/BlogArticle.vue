<script setup lang="ts">
import type { BlogArticlesCollectionItem } from '@nuxt/content'

defineProps<{
  article: BlogArticlesCollectionItem
}>()
</script>

<template>

  <ArticleLayout :item="article">
    <template #header="{ cover }">
      <UPageHeader :title="article.title">
        <template #description>
          <div v-if="article.categories?.length || article.published" class="flex flex-wrap items-center gap-2 mb-5">
            <CategoriesBadges v-if="article.categories?.length" :categories-stems="article.categories" />
            <NuxtTime v-if="article.published" :datetime="article.published" />
          </div>
          {{ article.description }}
        </template>
      </UPageHeader>

      <AudioPlayer v-if="article.audio" :src="article.audio" :title="article.title" :cover="cover" />

    </template>
  </ArticleLayout>
</template>
