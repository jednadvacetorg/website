<script setup lang="ts">
const route = useRoute()
const articlePath = route.path.replace(/^\/debug/, '') || '/'

const { data: article } = await useAsyncData(`debug-${articlePath}`, async () => {
  return queryCollection('blogArticles').path(articlePath).first()
})

if (!article.value) {
  throw createError({ statusCode: 404, statusMessage: 'Article not found', fatal: true })
}

definePageMeta({
  layout: 'default',
})

useSeoMeta({
  robots: 'noindex',
})

useHead({
  title: `OG debug: ${article.value.title}`,
})

const ogImage = buildOgImageCall({
  title: article.value.title,
  image: article.value.thumbnail,
})

// Same template and settings as the public article; URLs are in variant order.
const urls = defineOgImage('Article', ogImage.sharedProps, ogImage.allOptions)

const previews = ogImageVariants.map((variant, index) => ({
  ...variant,
  url: urls[index] ?? '',
}))

function downloadImage(url: string, filename: string) {
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
}
</script>

<template>
  <div class="max-w-6xl mx-auto py-8 px-4">
    <header class="mb-8">
      <UButton
        color="neutral"
        variant="link"
        leading-icon="i-streamline-interface-arrows-left-arrow-keyboard-left"
        :to="articlePath"
      >
        Zpět na článek
      </UButton>
      <h1 class="text-3xl font-bold mt-4">OG Image Debug</h1>
      <p class="text-gray-500 mt-2">{{ article?.title }}</p>
    </header>

    <div v-if="!article" class="text-center py-12">
      <p class="text-gray-500">Načítám…</p>
    </div>

    <div v-else class="space-y-8">
      <div>
        <h2 class="text-xl font-semibold mb-4">Společný fotografický podklad</h2>
        <div class="aspect-video bg-gray-100 dark:bg-gray-800 rounded-lg overflow-hidden">
          <img
            :src="article.thumbnail"
            :alt="article.title"
            class="w-full h-full object-cover"
          />
        </div>
        <p class="text-sm text-gray-500 mt-2">{{ article.thumbnail }}</p>
      </div>

      <div>
        <h2 class="text-xl font-semibold mb-4">Vygenerované varianty</h2>
        <div class="grid gap-6">
          <div
            v-for="preview in previews"
            :key="preview.key"
            class="border border-gray-200 dark:border-gray-700 rounded-lg p-4"
          >
            <div class="flex items-center justify-between mb-3">
              <div>
                <h3 class="font-semibold">{{ preview.label }}</h3>
                <p class="text-sm text-gray-500">{{ preview.description }}</p>
              </div>
              <div class="flex gap-2 items-center">
                <UBadge v-if="preview.isPublic" variant="subtle" color="primary">
                  Veřejné meta
                </UBadge>
                <UBadge variant="subtle" color="neutral">
                  {{ preview.width }}×{{ preview.height }}
                </UBadge>
              </div>
            </div>

            <div
              class="bg-gray-100 dark:bg-gray-800 rounded overflow-hidden"
              :style="{ aspectRatio: `${preview.width} / ${preview.height}` }"
            >
              <img
                :src="preview.url"
                :alt="`Náhled ${preview.label}`"
                class="w-full h-full object-cover"
                loading="lazy"
              />
            </div>

            <div class="mt-3 flex gap-2 items-center">
              <UButton
                color="primary"
                variant="subtle"
                size="sm"
                :to="preview.url"
                target="_blank"
                external
              >
                Otevřít
              </UButton>
              <UButton
                color="neutral"
                variant="subtle"
                size="sm"
                @click="downloadImage(preview.url ?? '', `${preview.key}.png`)"
              >
                Stáhnout
              </UButton>
              <img
                :src="preview.url"
                :alt="`Malý náhled ${preview.label}`"
                class="ml-auto rounded border border-gray-200 dark:border-gray-700"
                width="160"
                loading="lazy"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
