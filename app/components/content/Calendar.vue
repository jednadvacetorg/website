<script setup lang="ts">
import type { PortalEvent } from '#shared/types/portalEvents'
import { eventJsonLd, projectCalendarEvents } from '~/utils/calendar'

const { community } = defineProps<{ community: string }>()
const { $counterscale } = useNuxtApp()

const endpoint = computed(() => `/api/events?community=${encodeURIComponent(community)}`)
const { data, error, status, refresh } = await useFetch<PortalEvent[]>(endpoint, {
  key: endpoint,
})

const events = computed(() => projectCalendarEvents(data.value ?? []))
const isMissingPortalMeetup = computed(() => status.value === 'error' && error.value?.statusCode === 404)
const allTagsValue = '__all_tags__'
const pageSize = 8
const selectedTags = ref<string[]>([allTagsValue])
const page = ref(1)
const tagOptions = computed(() => [{ label: 'Všechny štítky', value: allTagsValue }, ...Array.from(
  new Set(events.value.flatMap(event => event.tagNames.map(tag => tag.trim())).filter(Boolean)),
).sort((a, b) => a.localeCompare(b, 'cs')).map(tag => ({ label: tag, value: tag }))])
const filteredEvents = computed(() => selectedTags.value.includes(allTagsValue)
  ? events.value
  : events.value.filter(event => event.tagNames.some(tag => selectedTags.value.includes(tag.trim()))))
const paginatedEvents = computed(() => filteredEvents.value.slice(
  (page.value - 1) * pageSize,
  page.value * pageSize,
))
const hasActiveFilter = computed(() => !selectedTags.value.includes(allTagsValue))
const isSubscriptionOpen = ref(false)

const updateSelectedTags = (values: string[]) => {
  if (values.includes(allTagsValue)) {
    selectedTags.value = selectedTags.value.includes(allTagsValue)
      ? values.filter(value => value !== allTagsValue)
      : [allTagsValue]
  } else {
    selectedTags.value = values.length ? values : [allTagsValue]
  }
  page.value = 1
}

watch(isSubscriptionOpen, isOpen => {
  if (isOpen) $counterscale.trackSubscriptionGuide()
})

const eventLinkHostname = (safeLink: string) => new URL(safeLink).hostname

onMounted(() => refresh())

useHead(() => ({
  script: data.value?.length
    ? [{
        key: `calendar-json-ld-${community}`,
        type: 'application/ld+json',
        innerHTML: eventJsonLd(data.value),
      }]
    : [],
}))
</script>

<template>
  <UPageCard
    as="section"
    aria-labelledby="calendar-title"
    class="my-8 min-w-0"
    :ui="{
      container: 'min-w-0',
      wrapper: 'min-w-0',
      header: 'w-full',
      body: 'w-full min-w-0',
      footer: 'w-full',
    }"
  >
    <template #header>
      <div class="flex w-full flex-wrap items-center justify-between gap-3">
        <h2 id="calendar-title" class="text-xl font-semibold leading-tight">Nadcházející události</h2>
        <USelectMenu
          v-if="tagOptions.length > 1"
          :model-value="selectedTags"
          :items="tagOptions"
          value-key="value"
          multiple
          :search-input="false"
          aria-label="Filtrovat události podle štítků"
          class="w-52 max-w-full"
          @update:model-value="updateSelectedTags"
        />
      </div>
    </template>

    <template #body>
      <div class="min-w-0" aria-live="polite">
      <template v-if="status === 'pending' && !data">
        <p role="status" class="text-sm text-muted">Načítání událostí…</p>
      </template>
      <UAlert
        v-else-if="status === 'error' && !isMissingPortalMeetup"
        role="alert"
        color="neutral"
        variant="subtle"
        title="Kalendář se nyní nepodařilo načíst. Zkuste stránku obnovit později."
      />
      <div v-else-if="isMissingPortalMeetup || data?.length === 0" role="status" class="text-center p-10">
        <h3 class="text-xl font-semibold leading-tight">Žádné naplánované události</h3>
        <p class="mt-2 text-sm text-muted">Nyní nejsou naplánované žádné budoucí události.</p>
      </div>
      <div v-else-if="filteredEvents.length === 0" role="status">
        <h3 class="text-xl font-semibold leading-tight">Žádné odpovídající události</h3>
        <p class="mt-2 text-sm text-muted">Vybraným štítkům neodpovídá žádná naplánovaná událost.</p>
      </div>
      <template v-else>
        <UAccordion :items="paginatedEvents" value-key="id" :ui="{ trigger: 'text-base' }">
          <template #default="{ item: event }">
            <span class="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
              <span class="shrink-0 flex gap-2 items-center">
                <div class="text-3xl text-primary font-thin w-[1.4em]">
                  {{ event.weekdayLabel }}
                </div>
                <div class="text-xs text-muted w-[10em]">
                  <time class="block" :datetime="event.start">{{ event.dateLabel }}</time>
                  <time :datetime="event.start">{{ event.startTime }}</time>
                  <template v-if="event.endTime && event.end">
                    – <time :datetime="event.end">{{ event.endTime }}</time>
                  </template>
                </div>
              </span>
              <span class="min-w-0 font-medium text-highlighted flex flex-wrap gap-3">
                {{ event.title }}
                <UBadge v-if="event.community" color="neutral" variant="subtle" size="md">
                  {{ event.community.name }}
                </UBadge>
                <UBadge v-for="tag in event.tagNames" :key="tag" color="neutral" variant="outline" size="md">
                  {{ tag }}
                </UBadge>
              </span>
            </span>
          </template>

          <template #content="{ item: event }">
            <div class="space-y-4 py-3.5 text-sm">
              <div
                v-if="event.osmMapUri || event.location || event.community"
                class="flex flex-wrap justify-between gap-x-4 gap-y-1 text-muted"
              >
                <p v-if="event.osmMapUri || event.location" class="space-x-1">
                  <span class="font-medium text-highlighted">Místo:</span>
                  <a
                    v-if="event.osmMapUri"
                    :href="event.osmMapUri"
                    class="font-medium text-highlighted underline decoration-primary underline-offset-2"
                  >{{ event.osm_name }}</a>
                  <span v-if="event.location" :class="event.osmMapUri ? 'text-xs' : undefined">{{ event.location }}</span>
                </p>
                <!-- <p v-if="event.community">
                 <span class="font-medium text-highlighted">Komunita:</span>
                 <ULink :to="event.community.path" class="ms-1">{{ event.community.name }}</ULink>
                </p> -->
              </div>
              <MDC v-if="event.description" :value="event.description" class="prose prose-sm dark:prose-invert" />
              <UButton
                v-if="event.safeLink"
                :to="event.safeLink"
                target="_blank"
                rel="noopener noreferrer"
                trailing-icon="i-lucide-external-link"
                :aria-label="`Otevřít událost ${event.title} v novém okně.`"
              >
                {{ eventLinkHostname(event.safeLink) }}
              </UButton>
            </div>
          </template>
        </UAccordion>
        <div class="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-default pt-4">
          <p class="text-sm text-muted">
            <template v-if="hasActiveFilter">Zobrazeno {{ filteredEvents.length }} z {{ events.length }} naplánovaných událostí.</template>
            <template v-else>Celkem {{ events.length }} naplánovaných událostí.</template>
          </p>
          <UPagination
            v-if="filteredEvents.length > pageSize"
            v-model:page="page"
            :total="filteredEvents.length"
            :items-per-page="pageSize"
            :sibling-count="0"
            size="sm"
          />
        </div>
      </template>
      </div>
    </template>

    <template #footer>
      <div class="flex w-full flex-col items-center gap-3 text-center">
        <div class="my-5 flex flex-wrap items-center justify-center gap-3">
          <span>Nenech si ujít žádnou akci</span>
          <UModal v-model:open="isSubscriptionOpen" title="Sledovat události" scrollable>
            <UButton>Sledovat události</UButton>

            <template #body>
              <SubscriptionGuide v-if="isSubscriptionOpen" :initial-community="community" />
            </template>
          </UModal>
        </div>
        <div class="flex items-center justify-center gap-3 text-xl text-muted" aria-label="Možnosti sledování událostí">
          <UIcon name="i-simple-icons-googlecalendar" role="img" aria-label="Google Calendar" title="Google Calendar" />
          <UIcon name="i-simple-icons-apple" role="img" aria-label="Apple Kalendář" title="Apple Kalendář" />
          <UIcon name="i-simple-icons-microsoftoutlook" role="img" aria-label="Outlook" title="Outlook" />
          <UIcon name="i-lucide-mail" role="img" aria-label="E-mail" title="E-mail" />
          <UIcon name="i-lucide-smartphone" role="img" aria-label="Mobil" title="Mobil" />
        </div>
      </div>
    </template>
  </UPageCard>
</template>
