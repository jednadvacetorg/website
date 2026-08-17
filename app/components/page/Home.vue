<script setup lang="ts">
const props = withDefaults(defineProps<{
  articleColumns?: 1 | 2 | 3 | 4 | 5 | 6
  articleLimit?: number
}>(), {
  articleColumns: 4,
  articleLimit: 8,
})

const gridColsClass: Record<number, string> = {
  1: 'grid-cols-1',
  2: 'grid-cols-1 sm:grid-cols-2',
  3: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
  4: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4',
  5: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-5',
  6: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-6',
}

const { data: blogCategories } = useDataBlogCategories()
const { data: blogArticles } = await useDataBlogArticles(props.articleLimit ?? 8)
const { data: communities } = await useDataCommunities()

const communityBadge = computed(() => {
  const n = communities.value?.length ?? 0
  if (n === 1) return 'Máme už 1 lokální komunitu'
  if (n >= 2 && n <= 4) return `Máme už ${n} lokální komunity`
  return `Máme už ${n} lokálních komunit`
})
</script>

<template>
  <div>
    <!-- Hero -->
    <section class="relative overflow-hidden bg-linear-to-b from-orange-950/40 to-transparent mt-[calc(-1*var(--ui-header-height))] pt-[calc(var(--ui-header-height)+5rem)] pb-20">
      <UContainer>
        <div class="max-w-2xl mx-auto text-center">
          <!-- Social proof -->
          <div class="inline-flex items-center gap-2 rounded-full bg-orange-950/60 border border-orange-800/40 px-4 py-1.5 text-sm text-orange-300 mb-8">
            <span class="w-2 h-2 rounded-full bg-orange-400 animate-pulse" />
            {{ communityBadge }}
          </div>

          <h1 class="text-5xl sm:text-7xl font-bold tracking-tight mb-6">
            Bitcoin blíž<br />k tobě
          </h1>

          <p class="text-xl text-gray-400 mb-10">
            Jednadvacet je neformální síť lokálních bitcoinových komunit v&nbsp;České republice. Najdi meetupy, lidi a podniky přijímající bitcoin ve svém městě.
          </p>

          <div class="flex flex-wrap gap-3 justify-center">
            <UButton to="/brno" size="xl" color="primary">Najít komunitu</UButton>
            <UButton to="/blog" size="xl" variant="outline">Číst blog</UButton>
          </div>
        </div>

        <!-- Visual placeholder -->
        <div class="mt-16 rounded-2xl bg-gray-900 border border-gray-800 h-80 flex items-center justify-center text-gray-600 text-sm">
          Mapa komunit
        </div>
      </UContainer>
    </section>

    <!-- Blog posts grid -->
    <section class="py-16">
      <UContainer>
        <div class="flex items-center justify-between mb-8">
          <h2 class="text-2xl font-bold">
            Nejnovější články
          </h2>
          <UButton to="/blog" variant="link" color="neutral" trailing-icon="i-lucide-arrow-right">
            Všechny články
          </UButton>
        </div>
        <div :class="`grid gap-6 ${gridColsClass[props.articleColumns ?? 4]}`">
          <UBlogPost
            v-for="article in blogArticles"
            :key="article.path"
            :title="article.title"
            :description="article.description"
            :image="article.thumbnail
              ? { src: article.thumbnail, sizes: '100vw sm:50vw lg:400px', width: 600, height: 338, format: 'webp', loading: 'lazy' }
              : 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAAD0lEQVR4AQEEAPv/AMzMzATMAmVMDHrmAAAAAElFTkSuQmCC'"
            :date="article.published"
            :to="article.path"
            orientation="vertical"
            variant="card"
          />
        </div>
      </UContainer>
      <UContainer>
	<div class="flex flex-wrap gap-3 justify-center py-4">
	  <UButton
	    v-for="category in blogCategories"
	    :key="category.path"
	    :to="category.path"
	    variant="outline"
	    color="neutral"
	  >
	    {{ category.title }}
	  </UButton>
	</div>
      </UContainer>
    </section>

    <!-- Subscribe CTA -->
    <section class="py-16">
      <UContainer>
        <div class="max-w-2xl mx-auto">
          <SubscribeCta />
        </div>
      </UContainer>
    </section>
  </div>
</template>
