<script setup lang="ts">
const { initialCommunity, directEntry = false } = defineProps<{
  initialCommunity?: string
  directEntry?: boolean
}>()
const { $counterscale } = useNuxtApp()

const wholeCountryValue = 'all-czech-communities'
const fakeDoorAlert = 'Tato možnost ještě není připravená, takže jsme nic neaktivovali. Sledujte prosím naše sociální sítě; už teď můžete odebírat kalendář přes iCalendar.'

// These browser-only convenience values are owned by this guide, retained until
// the visitor clears them, and never cross a network or analytics boundary.
const storedTelephone = useLocalStorage<string | null>('subscription-guide-telephone', null, { initOnMounted: true })
const storedEmail = useLocalStorage<string | null>('subscription-guide-email', null, { initOnMounted: true })
const telephone = computed({
  get: () => storedTelephone.value ?? '',
  set: value => { storedTelephone.value = value || null },
})
const email = computed({
  get: () => storedEmail.value ?? '',
  set: value => { storedEmail.value = value || null },
})

const { data: communities, status, refresh } = await useAsyncData('subscription-guide-communities', () => {
  return queryCollection('communities')
    .select('path', 'title')
    .all()
})

const communityOptions = computed(() => [
  { label: 'Celé Česko', value: wholeCountryValue },
  ...(communities.value ?? []).map(community => ({ label: community.title, value: community.path.replace(/^\//, '') })),
])
const selectedCommunitySlugs = ref<string[]>([])
const hasInitializedScope = ref(false)

const normalizeScope = (scope: readonly string[]) => {
  const availableSlugs = new Set(communityOptions.value.map(option => option.value))
  return [...new Set(scope.filter(value => availableSlugs.has(value)))]
}

watch(communities, (loadedCommunities) => {
  if (!loadedCommunities) return

  if (!hasInitializedScope.value) {
    selectedCommunitySlugs.value = initialCommunity && communityOptions.value.some(option => option.value === initialCommunity)
      ? [initialCommunity]
      : [wholeCountryValue]
    hasInitializedScope.value = true
  }
}, { immediate: true })

const copiedCalendarUrl = ref<string | null>(null)
const copyError = ref<string | null>(null)

const updateCommunityScope = (scope: string[]) => {
  const validScope = normalizeScope(scope)
  const selectedWholeCountry = scope.includes(wholeCountryValue)
  const hadWholeCountry = selectedCommunitySlugs.value.includes(wholeCountryValue)

  selectedCommunitySlugs.value = selectedWholeCountry && !hadWholeCountry
    ? [wholeCountryValue]
    : hadWholeCountry
      ? validScope.filter(value => value !== wholeCountryValue)
      : selectedWholeCountry
        ? [wholeCountryValue]
        : validScope
  copiedCalendarUrl.value = null
  copyError.value = null
}

const selectedCommunities = computed(() => {
  const configuredCommunities = communities.value ?? []
  if (selectedCommunitySlugs.value.includes(wholeCountryValue)) return configuredCommunities
  const selectedSlugs = new Set(selectedCommunitySlugs.value)
  return configuredCommunities.filter(community => selectedSlugs.has(community.path.replace(/^\//, '')))
})
const hasSelectedScope = computed(() => selectedCommunities.value.length > 0)
const currentOrigin = ref(useRequestURL().origin)
const calendarUrls = computed(() => {
  if (!hasSelectedScope.value) return []
  const scope = selectedCommunitySlugs.value.includes(wholeCountryValue)
    ? 'all'
    : selectedCommunities.value.map(community => community.path.replace(/^\//, '')).sort().join(',')
  return [{
    title: selectedScopeSummary.value,
    url: `${currentOrigin.value}/ical/${scope}`,
  }]
})
const hasTelephone = computed(() => telephone.value.trim().length > 0)
const hasEmail = computed(() => email.value.trim().length > 0)
const selectedScopeSummary = computed(() => selectedCommunitySlugs.value.includes(wholeCountryValue)
  ? 'Celé Česko'
  : selectedCommunities.value.map(community => community.title).join(', '))

const frequencyChoices = [
  { value: 'created', label: 'při vytvoření události' },
  { value: 'week-before', label: 'týden předem' },
  { value: 'day-before', label: 'den předem' },
] as const
type FrequencyValue = typeof frequencyChoices[number]['value']

const selectedFrequencies = ref<FrequencyValue[]>(['created'])
const isEditingFrequency = ref(false)
const frequencySummary = computed(() => frequencyChoices
  .filter(choice => selectedFrequencies.value.includes(choice.value))
  .map(choice => choice.label)
  .join(', '))

const setFrequency = (value: FrequencyValue, checked: boolean | 'indeterminate') => {
  if (checked === true) {
    selectedFrequencies.value = [...new Set([...selectedFrequencies.value, value])]
    return
  }

  if (selectedFrequencies.value.length > 1) {
    selectedFrequencies.value = selectedFrequencies.value.filter(choice => choice !== value)
  }
}

const futureMethods = [
  {
    title: 'SMS',
    description: 'Upozornění na vybrané události dostanete jako SMS.',
  },
  {
    title: 'E-mail',
    description: 'Upozornění e-mailem může obsahovat událost, kterou si přidáte do vlastního kalendáře.',
  },
  {
    title: 'Oznámení ve webu',
    description: 'Upozornění dostanete přímo v tomto prohlížeči.',
  },
] as const

const retryCommunities = () => refresh()

const expressSmsInterest = () => {
  $counterscale.trackSmsIntent()
  window.alert(fakeDoorAlert)
}

const expressEmailInterest = () => {
  $counterscale.trackEmailIntent()
  window.alert(fakeDoorAlert)
}

const expressWebInterest = () => {
  $counterscale.trackWebIntent()
  window.alert(fakeDoorAlert)
}

const copyCalendarUrl = async (url: string) => {
  copyError.value = null
  $counterscale.trackICalendarCopy()

  try {
    await navigator.clipboard.writeText(url)
    copiedCalendarUrl.value = url
  } catch {
    copiedCalendarUrl.value = null
    copyError.value = 'Adresu se nepodařilo zkopírovat. Označte ji a zkopírujte ručně.'
  }
}

onMounted(() => {
  currentOrigin.value = window.location.origin
  if (directEntry) $counterscale.trackSubscriptionGuide()
})
</script>

<template>
  <section
    class="mx-auto w-full min-w-0 max-w-[720px] space-y-8"
    :aria-labelledby="directEntry ? 'subscription-guide-title' : undefined"
  >
    <div v-if="directEntry" class="space-y-2">
      <h2 id="subscription-guide-title" class="text-[28px] font-semibold leading-tight">Sledovat události</h2>
      <p>Vyberte si komunity a způsob, jakým chcete jejich události sledovat.</p>
    </div>

    <div class="space-y-2">
      <label for="subscription-community-scope" class="text-sm font-semibold">Komunity, které chcete sledovat</label>
      <USelectMenu
        id="subscription-community-scope"
        :model-value="selectedCommunitySlugs"
        :items="communityOptions"
        value-key="value"
        multiple
        clear
        :disabled="status === 'pending' || status === 'error' || !communities"
        :search-input="{ placeholder: 'Hledat komunitu…' }"
        aria-label="Komunity, které chcete sledovat"
        placeholder="Vyberte komunity"
        class="w-full"
        @update:model-value="updateCommunityScope"
      />
      <p v-if="status === 'pending'" role="status" class="text-sm text-muted">Načítáme komunity…</p>
      <div v-else-if="status === 'error' || !communities" class="space-y-3" role="alert">
        <p class="text-sm text-muted">Komunity se nyní nepodařilo načíst. Obnovte stránku a zkuste to znovu.</p>
        <UButton color="neutral" variant="outline" @click="retryCommunities">Obnovit</UButton>
      </div>
      <p v-else-if="communities.length === 0" role="status" class="text-sm text-muted">Pro odběr kalendáře zatím není nastavená žádná komunita.</p>
      <p v-else-if="hasSelectedScope" class="text-sm text-muted">
        Vybráno: <span class="font-semibold text-highlighted">{{ selectedScopeSummary }}</span>
      </p>
    </div>

    <div v-if="status === 'success' && communities?.length" class="space-y-3">
      <div class="flex flex-wrap items-center gap-2">
        <p class="text-sm font-semibold">Frekvence upozornění</p>
        <span class="text-sm text-muted">{{ frequencySummary }}</span>
        <UButton
          color="neutral"
          variant="link"
          :disabled="!hasSelectedScope"
          @click="isEditingFrequency = true"
        >
          Upravit
        </UButton>
      </div>
      <div v-if="isEditingFrequency" class="space-y-3 rounded-lg border border-default bg-elevated p-4">
        <p class="text-sm font-semibold">Kdy chcete dostávat upozornění?</p>
        <UCheckbox
          v-for="choice in frequencyChoices"
          :key="choice.value"
          :model-value="selectedFrequencies.includes(choice.value)"
          :label="choice.label"
          @update:model-value="setFrequency(choice.value, $event)"
        />
        <UButton color="neutral" variant="outline" @click="isEditingFrequency = false">Hotovo</UButton>
      </div>
    </div>

    <div v-if="status === 'success' && communities?.length" class="space-y-4">
      <div v-if="!hasSelectedScope" class="rounded-lg border border-default bg-elevated p-4" role="status">
        <h3 class="text-xl font-semibold leading-tight">Vyberte alespoň jednu komunitu</h3>
        <p class="mt-2 text-sm text-muted">Potom vám ukážeme dostupné možnosti sledování a adresu kalendáře.</p>
      </div>

      <template v-for="(method, index) in futureMethods" :key="method.title">
        <section class="space-y-4">
          <h3 class="text-xl font-semibold leading-tight">{{ method.title }}</h3>
          <p>{{ method.description }}</p>

          <template v-if="method.title === 'SMS'">
            <UFormField label="Telefonní číslo" name="telephone">
              <UInput
                v-model="telephone"
                type="tel"
                autocomplete="tel"
                class="w-full"
              />
            </UFormField>
            <UButton color="neutral" :disabled="!hasSelectedScope || !hasTelephone" @click="expressSmsInterest">Mám zájem o SMS</UButton>
          </template>

          <template v-else-if="method.title === 'E-mail'">
            <UFormField label="E-mail" name="email">
              <UInput
                v-model="email"
                type="email"
                autocomplete="email"
                class="w-full"
              />
            </UFormField>
            <UButton color="neutral" :disabled="!hasSelectedScope || !hasEmail" @click="expressEmailInterest">Mám zájem o e-mail</UButton>
          </template>

          <UButton v-else color="neutral" :disabled="!hasSelectedScope" @click="expressWebInterest">Mám zájem o oznámení ve webu</UButton>
        </section>
        <USeparator v-if="index < futureMethods.length - 1" label="nebo" />
      </template>

      <USeparator label="nebo" />
      <section class="min-w-0 space-y-4">
        <h3 class="text-xl font-semibold leading-tight">Kalendářový feed</h3>
        <p>Zkopírujte si adresu a přihlaste ji k odběru ve své kalendářové aplikaci.</p>
        <p v-if="hasSelectedScope" class="text-sm text-muted">Vybraný rozsah: {{ selectedScopeSummary }}</p>
        <p v-else class="text-sm text-muted">Vyberte alespoň jednu komunitu, abyste získali adresu kalendáře.</p>

        <div v-if="hasSelectedScope" class="space-y-4">
          <div v-for="calendar in calendarUrls" :key="calendar.url" class="space-y-2">
            <p class="text-sm font-semibold text-highlighted">{{ calendar.title }}</p>
            <div class="flex min-w-0">
              <code
                tabindex="0"
                :aria-label="`Adresa kalendáře pro ${calendar.title}`"
                class="min-w-0 flex-1 select-all overflow-hidden text-ellipsis whitespace-nowrap rounded-s-md border border-e-0 border-default bg-elevated px-3 py-2 text-xs"
              >{{ calendar.url }}</code>
              <UButton
                color="primary"
                square
                :aria-label="copiedCalendarUrl === calendar.url ? 'Adresa zkopírována' : 'Kopírovat adresu kalendáře'"
                :title="copiedCalendarUrl === calendar.url ? 'Adresa zkopírována' : 'Kopírovat adresu kalendáře'"
                class="shrink-0 justify-center rounded-s-none"
                @click="copyCalendarUrl(calendar.url)"
              >
                <UIcon v-show="copiedCalendarUrl !== calendar.url" name="i-lucide-copy" class="size-5" />
                <UIcon v-show="copiedCalendarUrl === calendar.url" name="i-lucide-check" class="size-5" />
              </UButton>
            </div>
          </div>
        </div>

        <UAlert
          v-if="copyError"
          role="status"
          aria-live="polite"
          color="neutral"
          variant="subtle"
          :title="copyError"
        />

        <div class="space-y-2 text-sm text-muted">
          <p>Přihlášení k odběru přes adresu URL udržuje kalendář aktuální. Stažený soubor .ics je jen jednorázová kopie.</p>
          <p>Čas obnovení určuje vaše kalendářová aplikace.</p>
        </div>

        <div class="flex flex-wrap gap-2" aria-label="Návody pro kalendářové aplikace">
          <UPopover>
            <UButton icon="i-simple-icons-googlecalendar" color="neutral" variant="ghost" class="size-11" aria-label="Google Calendar" title="Google Calendar" />
            <template #content>
              <p class="max-w-sm p-3 text-sm">V Kalendáři Google otevřete Další kalendáře → Přidat další kalendáře → Z adresy URL. Vložte zkopírovanou adresu a potvrďte Přidat kalendář.</p>
            </template>
          </UPopover>
          <UPopover>
            <UButton icon="i-simple-icons-apple" color="neutral" variant="ghost" class="size-11" aria-label="Apple Kalendář" title="Apple Kalendář" />
            <template #content>
              <p class="max-w-sm p-3 text-sm">iPhone/iPad: Nastavení → Aplikace → Kalendář → Účty kalendáře → Přidat účet → Jiný → Přidat odebíraný kalendář. Mac: Kalendář → Soubor → Nové přihlášení k odběru kalendáře. V obou případech vložte adresu URL.</p>
            </template>
          </UPopover>
          <UPopover>
            <UButton icon="i-simple-icons-microsoftoutlook" color="neutral" variant="ghost" class="size-11" aria-label="Outlook" title="Outlook" />
            <template #content>
              <p class="max-w-sm p-3 text-sm">V Outlooku na webu vyberte Přidat kalendář → Přihlásit se k odběru z webu, vložte adresu a uložte. Nevolte Importovat kalendář; ten vytvoří jen jednorázovou kopii.</p>
            </template>
          </UPopover>
          <UPopover>
            <UButton icon="i-lucide-circle-help" color="neutral" variant="ghost" class="size-11" aria-label="Jiná aplikace" title="Jiná aplikace" />
            <template #content>
              <p class="max-w-sm p-3 text-sm">V aplikaci hledejte volbu jako Přihlásit se k odběru kalendáře, Přidat kalendář z URL nebo Síťový kalendář. Vložte zkopírovanou adresu jako nový odebíraný kalendář.</p>
            </template>
          </UPopover>
        </div>
      </section>
    </div>
  </section>
</template>
