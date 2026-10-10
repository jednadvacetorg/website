<script setup lang="ts">
import LightningQrCode from './LightningQrCode.vue'

const { slug } = defineProps<{
  slug: string
}>()

const { data } = await useAsyncData(`person-${slug}`, async () => {
  const [person, articles, communities] = await Promise.all([
    queryCollection('people').path(`/people/${slug}`).first(),
    queryCollection('blogArticles').order('id', 'DESC').select('path', 'title', 'authors').all(),
    queryCollection('communities').order('title', 'ASC').select('path', 'title', 'organizers').all(),
  ])

  return {
    person,
    articles: articles.filter(article => article.authors?.includes(slug)),
    communities: communities.filter(community => community.organizers?.includes(slug)),
  }
})

if (!data.value?.person) throw createError(`/content/people/${slug}.md nenalezen`)

const person = computed(() => data.value?.person)
const articles = computed(() => data.value?.articles || [])
const communities = computed(() => data.value?.communities || [])

const isDonateOpen = ref(false)
const isArticlesOpen = ref(false)

const lightningUrl = computed(() => {
  if (!person.value?.donateLnAddress) return null
  return `lightning:${person.value.donateLnAddress}`
})
</script>

<template>
  <div v-if="person" class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-8 py-6">
    <UAvatar :src="person.avatar" :alt="person.title" size="3xl"
      :width="144" :height="144" sizes="64px sm:80px md:144px"
      :ui="{ root: 'col-start-1 row-start-1 size-16 sm:size-20 md:size-36 sm:row-span-3 md:self-center' }" />

    <div class="col-start-2 row-start-1 flex gap-4 flex-wrap items-center min-w-0">
      <h3 class="font-semibold text-lg grow">{{ person.title }}</h3>
      <div class="flex flex-wrap gap-4">
        <UModal v-if="person.donateLnAddress" v-model:open="isDonateOpen" title="Podpořit přes Lightning"
          :ui="{ footer: 'justify-center' }">
          <UButton size="md" trailing-icon="i-bitcoin-icons-lightning-filled">
            Podpořit
          </UButton>

          <template #body>
            <div class="flex flex-col items-center gap-4">
              <div class="rounded-lg border border-muted p-3 bg-white">
                <LightningQrCode
                  v-if="person.donateLnAddress"
                  :address="person.donateLnAddress"
                  :alt="`QR ${person.title}`"
                />
              </div>
              <p class="text-sm text-muted text-center">
                {{ person.donateLnAddress }}
              </p>
              <UButton v-if="lightningUrl" :to="lightningUrl" target="_blank"
                trailing-icon="i-bitcoin-icons-lightning-filled">
                Otevřít peněženku
              </UButton>
            </div>
          </template>
        </UModal>
        <SocialLinks :links="person.links || []" />
      </div>
    </div>

    <ContentRenderer v-if="person.body" :value="person"
      class="col-span-2 row-start-2 text-sm text-muted prose dark:prose-invert prose-sm mt-1 sm:col-span-1 sm:col-start-2" />

    <div class="col-span-2 row-start-3 sm:col-span-1 sm:col-start-2">
      <p v-if="articles.length || communities.length" class="mt-3 text-sm text-muted">
        <template v-if="communities.length">
          Organizátor
          <template v-for="(community, index) in communities" :key="community.path">
            <span v-if="index">, </span>
            <ULink :to="community.path" class="text-default underline decoration-primary underline-offset-2">{{ community.title }}</ULink>
          </template>
        </template>
        <span v-if="articles.length && communities.length">, </span>
        <template v-if="articles.length">
          Autor
          <UButton color="primary" variant="link" :label="`${articles.length} článků`" class="align-baseline" :ui="{ base: 'p-0' }" @click="isArticlesOpen = true" />.
        </template>
      </p>

      <UModal v-if="articles.length" v-model:open="isArticlesOpen" title="Články autora">
        <template #body>
          <ul class="space-y-2">
            <li v-for="article in articles" :key="article.path">
              <ULink :to="article.path" class="text-default underline decoration-primary underline-offset-2" @click="isArticlesOpen = false">{{ article.title }}</ULink>
            </li>
          </ul>
        </template>
      </UModal>
    </div>
  </div>
</template>
