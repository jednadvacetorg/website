<script setup lang="ts">
import type { CommunitiesCollectionItem } from '@nuxt/content'

const props = defineProps<{
  community: CommunitiesCollectionItem
}>()

const organizers = await useAsyncData('organizers-' + props.community.path, () => {
  if (!props.community.organizers?.length) return Promise.resolve([])
  const paths = props.community.organizers.map(s => `/people/${s}`)
  return queryCollection('people')
    .where('path', 'IN', paths)
    .select('path', 'title', 'avatar')
    .all()
})

function formatDate(iso: string) {
  return new Intl.DateTimeFormat('cs-CZ', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso))
}
</script>

<template>
  <Head>
    <Title>{{ community.title }} – Jednadvacet</Title>
    <Meta property="og:title" :content="`${community.title} – Jednadvacet`" />
    <Meta property="og:type" content="website" />
  </Head>

  <UContainer class="py-16 space-y-16 max-w-3xl">
    <!-- Header -->
    <header>
      <h1 class="text-5xl font-bold mb-4">{{ community.title }}</h1>
      <div v-if="community.meetup_schedule" class="inline-flex items-center gap-2 rounded-full border border-gray-800 px-4 py-1.5 text-sm text-gray-300">
        <UIcon name="i-lucide-calendar" class="w-4 h-4 text-primary shrink-0" />
        {{ community.meetup_schedule }}
      </div>
    </header>

    <!-- Připojit se -->
    <section v-if="community.signal_group">
      <h2 class="text-2xl font-bold mb-6">Připojit se</h2>
      <div class="rounded-xl border border-gray-800 bg-gray-950/50 p-6 flex flex-col sm:flex-row sm:items-center gap-6">
        <div class="flex-1">
          <p class="font-semibold mb-1">Signal skupina</p>
          <p class="text-sm text-gray-400">Přidej se do skupiny, domlouvají se tam meetupy a sdílí se novinky.</p>
        </div>
        <UButton
          :to="community.signal_group"
          target="_blank"
          color="primary"
          size="lg"
          icon="i-lucide-message-circle"
        >
          Přidat se
        </UButton>
      </div>
    </section>

    <!-- Lidé -->
    <section v-if="organizers.data.value?.length">
      <h2 class="text-2xl font-bold mb-6">Organizátoři</h2>
      <div class="flex flex-wrap gap-4">
        <NuxtLink
          v-for="person in organizers.data.value"
          :key="person.path"
          :to="person.path"
          class="flex items-center gap-3 rounded-xl border border-gray-800 hover:border-primary/50 hover:bg-gray-900 transition-colors px-4 py-3"
        >
          <UAvatar
            :src="person.avatar || undefined"
            :alt="person.title"
            :text="person.title?.[0]"
            size="md"
          />
          <span class="text-sm font-medium">{{ person.title }}</span>
        </NuxtLink>
      </div>
    </section>

    <!-- Nahrávky -->
    <section v-if="community.recordings?.length">
      <h2 class="text-2xl font-bold mb-6">Nahrávky přednášek</h2>
      <div class="space-y-3">
        <a
          v-for="rec in community.recordings"
          :key="rec.url"
          :href="rec.url"
          target="_blank"
          rel="noopener noreferrer"
          class="flex items-center gap-4 rounded-xl border border-gray-800 hover:border-primary/50 bg-gray-950/50 hover:bg-gray-900 transition-colors px-5 py-4 group"
        >
          <UIcon name="i-lucide-play-circle" class="w-8 h-8 text-primary shrink-0" />
          <div class="flex-1 min-w-0">
            <p class="font-semibold group-hover:text-primary transition-colors truncate">{{ rec.title }}</p>
            <p v-if="rec.date" class="text-sm text-gray-500">{{ formatDate(rec.date) }}</p>
          </div>
          <UIcon name="i-lucide-external-link" class="w-4 h-4 text-gray-600 group-hover:text-primary transition-colors shrink-0" />
        </a>
      </div>
    </section>

    <!-- BtcMap -->
    <section v-if="community.btcmap_community_id">
      <h2 class="text-2xl font-bold mb-6">Podniky přijímající bitcoin</h2>
      <div class="rounded-xl overflow-hidden border border-gray-800 h-96">
        <iframe
          :src="`https://btcmap.org/community/${community.btcmap_community_id}#9/${community.map?.lat ?? 50}/${community.map?.lng ?? 15}`"
          class="w-full h-full"
          loading="lazy"
          title="Mapa podniků přijímajících bitcoin"
        />
      </div>
      <p class="text-sm text-gray-500 mt-2">
        Chybí podnik?
        <a href="https://btcmap.org" target="_blank" class="text-primary hover:underline">Přidej ho na BtcMap</a>.
      </p>
    </section>

    <!-- Markdown body -->
    <div v-if="community.body" class="prose dark:prose-invert">
      <ContentRenderer :value="community" />
    </div>
  </UContainer>
</template>
