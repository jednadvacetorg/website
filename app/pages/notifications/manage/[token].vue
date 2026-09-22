<script setup lang="ts">
type Frequency = 'created' | 'week-before' | 'day-before'
type Community = { slug: string, title: string, frequencies: Frequency[] }
type ManagementResult = { state: 'active' | 'pending-reactivation', channel: 'email' | 'sms' | 'web-push', maskedContact: string, communities: Community[] } | { state: 'unavailable' }

const route = useRoute()
const heading = useTemplateRef<HTMLElement>('heading')
const stopTrigger = useTemplateRef<{ $el: HTMLButtonElement }>('stop-trigger')
const stopOpen = ref(false)
const stopped = ref(false)
const statusMessage = ref<string | null>(null)
const errorMessage = ref<string | null>(null)
const pendingRows = ref(new Set<string>())
const rowDrafts = ref<Record<string, Frequency[]>>({})
const isStopping = ref(false)
const isReactivating = ref(false)
const recoveryChannel = ref<'email' | 'sms'>('email')
const recoveryContact = ref('')
const recoveryChallenge = ref('')
const recoveryNeedsChallenge = ref(false)
const recoveryMessage = ref<string | null>(null)
const recoveryError = ref<string | null>(null)
const isRecovering = ref(false)
const frequencyChoices: { value: Frequency, label: string }[] = [
  { value: 'created', label: 'při vytvoření události' },
  { value: 'week-before', label: 'týden předem' },
  { value: 'day-before', label: 'den předem' },
]

const { data: result } = await useAsyncData(`notification-management-${route.path}`, () =>
  $fetch<ManagementResult>(`/api/notifications/manage/${encodeURIComponent(String(route.params.token ?? ''))}`)
    .catch(() => ({ state: 'unavailable' as const })),
)

const isAvailable = computed(() => result.value?.state === 'active' || result.value?.state === 'pending-reactivation')
const channelLabel = computed(() => result.value && 'channel' in result.value
  ? ({ email: 'E-mail', sms: 'SMS', 'web-push': 'Oznámení ve webu' })[result.value.channel]
  : '')
const currentCommunities = computed(() => result.value && 'communities' in result.value ? result.value.communities : [])

const frequencySummary = (frequencies: Frequency[]) => frequencies
  .map(frequency => frequencyChoices.find(choice => choice.value === frequency)?.label)
  .filter((label): label is string => Boolean(label))
  .join(', ')

const draftFrequencies = (community: Community) => rowDrafts.value[community.slug] ?? community.frequencies

const toggleDraftFrequency = (community: Community, frequency: Frequency, checked: boolean | 'indeterminate') => {
  const draft = draftFrequencies(community)
  rowDrafts.value = {
    ...rowDrafts.value,
    [community.slug]: checked === true
      ? [...new Set([...draft, frequency])]
      : draft.filter(value => value !== frequency),
  }
}

const updateResult = (next: ManagementResult) => {
  if (isAvailable.value && next.state === 'unavailable') stopped.value = true
  result.value = next
  rowDrafts.value = {}
}

const recoveryInputType = computed(() => recoveryChannel.value === 'email' ? 'email' : 'tel')
const recoveryInputLabel = computed(() => recoveryChannel.value === 'email' ? 'E-mail' : 'Telefonní číslo v mezinárodním formátu')

const switchRecoveryChannel = (channel: string) => {
  if (channel !== 'email' && channel !== 'sms') return
  recoveryChannel.value = channel
  recoveryContact.value = ''
  recoveryChallenge.value = ''
  recoveryNeedsChallenge.value = false
  recoveryError.value = null
}

const requestRecovery = async () => {
  const valid = recoveryChannel.value === 'email'
    ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recoveryContact.value)
    : /^\+[1-9]\d{6,14}$/.test(recoveryContact.value)
  recoveryError.value = null
  recoveryMessage.value = null
  if (!valid) {
    recoveryError.value = recoveryChannel.value === 'email' ? 'Zadej platný e-mail.' : 'Zadej telefonní číslo v mezinárodním formátu, například +420123456789.'
    return
  }
  isRecovering.value = true
  try {
    const response = await $fetch<{ message: string }>('/api/notifications/manage-request', {
      method: 'POST',
      body: {
        channel: recoveryChannel.value,
        contact: recoveryContact.value,
        ...(recoveryNeedsChallenge.value ? { turnstileToken: recoveryChallenge.value } : {}),
      },
    })
    recoveryMessage.value = response.message
  } catch (error: unknown) {
    const status = typeof error === 'object' && error && 'statusCode' in error ? error.statusCode : undefined
    if (status === 403) recoveryNeedsChallenge.value = true
    else recoveryError.value = 'Odkaz se teď nepodařilo odeslat. Zkus to prosím později.'
  } finally {
    isRecovering.value = false
  }
}

const mutate = async (body: Record<string, unknown>) => {
  errorMessage.value = null
  try {
    return await $fetch<ManagementResult>(`/api/notifications/manage/${encodeURIComponent(String(route.params.token ?? ''))}`, { method: 'POST', body })
  } catch {
    errorMessage.value = 'Nastavení se teď nepodařilo uložit. Nic jsme nezměnili. Zkus to prosím znovu.'
    return null
  }
}

const saveCommunity = async (community: Community, frequencies: Frequency[]) => {
  if (!frequencies.length) return
  pendingRows.value = new Set([...pendingRows.value, community.slug])
  const next = await mutate({ action: 'update-frequencies', communitySlug: community.slug, frequencies })
  if (next) {
    updateResult(next)
    statusMessage.value = 'Nastavení jsme uložili.'
  }
  pendingRows.value = new Set([...pendingRows.value].filter(slug => slug !== community.slug))
}

const removeCommunity = async (community: Community) => {
  pendingRows.value = new Set([...pendingRows.value, community.slug])
  const next = await mutate({ action: 'remove-community', communitySlug: community.slug })
  if (next) updateResult(next)
  pendingRows.value = new Set([...pendingRows.value].filter(slug => slug !== community.slug))
}

const stopChannel = async () => {
  isStopping.value = true
  const next = await mutate({ action: 'stop-channel' })
  if (next) {
    updateResult(next)
    stopOpen.value = false
  }
  isStopping.value = false
}

const reactivate = async () => {
  isReactivating.value = true
  const next = await mutate({ action: 'confirm-reactivation' })
  if (next) {
    updateResult(next)
    statusMessage.value = 'Odběr je znovu aktivní.'
  }
  isReactivating.value = false
}

const focusStopTrigger = () => stopTrigger.value?.$el.focus()

onMounted(() => heading.value?.focus())
</script>

<template>
  <main class="mx-auto w-full max-w-3xl space-y-8 px-4 py-8 sm:px-6">
    <template v-if="stopped">
      <h1 ref="heading" tabindex="-1" class="text-xl font-semibold leading-tight">Odběr je ukončený</h1>
      <UAlert color="success" title="Odběr v tomto kanálu je ukončený. Další upozornění ti už nepošleme." role="status" />
    </template>

    <template v-else-if="!isAvailable">
      <h1 ref="heading" tabindex="-1" class="text-xl font-semibold leading-tight">Odkaz pro správu není dostupný</h1>
      <p class="text-muted">Zkontroluj celý odkaz nebo si nech poslat nový odkaz pro správu.</p>
      <section class="space-y-4" aria-labelledby="recovery-heading">
        <h2 id="recovery-heading" class="text-lg font-semibold">Nechat si poslat nový odkaz</h2>
        <UForm class="space-y-4" @submit="requestRecovery">
          <UFormField name="channel" label="Kanál">
            <USelect :model-value="recoveryChannel" :items="[{ label: 'E-mail', value: 'email' }, { label: 'SMS', value: 'sms' }]" @update:model-value="switchRecoveryChannel" />
          </UFormField>
          <UFormField name="contact" :label="recoveryInputLabel" :error="recoveryError ?? undefined">
            <UInput v-model="recoveryContact" name="recovery-contact" :type="recoveryInputType" :autocomplete="recoveryInputType" class="min-h-11" />
          </UFormField>
          <UFormField v-if="recoveryNeedsChallenge" name="turnstileToken" label="Ověřovací kód">
            <UInput v-model="recoveryChallenge" name="turnstile-token" class="min-h-11" />
          </UFormField>
          <UButton type="submit" color="neutral" class="min-h-11 w-full sm:w-auto" :loading="isRecovering" :disabled="isRecovering">Poslat odkaz pro správu</UButton>
        </UForm>
        <div aria-live="polite">
          <UAlert v-if="recoveryMessage" color="success" :title="recoveryMessage" />
          <UAlert v-if="recoveryError" color="error" :title="recoveryError" role="alert" />
        </div>
      </section>
    </template>

    <template v-else>
      <header class="space-y-2">
        <h1 ref="heading" tabindex="-1" class="text-xl font-semibold leading-tight">Správa upozornění</h1>
        <div class="flex flex-wrap items-center gap-2">
          <p class="min-w-0 break-words text-muted">{{ result && 'maskedContact' in result ? result.maskedContact : '' }}</p>
          <UBadge color="neutral" variant="subtle">{{ channelLabel }}</UBadge>
        </div>
      </header>

      <div aria-live="polite" class="space-y-3">
        <UAlert v-if="statusMessage" color="success" :title="statusMessage" />
        <UAlert v-if="errorMessage" color="error" :title="errorMessage" role="alert" />
      </div>

      <section v-if="result!.state === 'pending-reactivation'" class="space-y-4">
        <UAlert color="warning" title="Tento kontakt už dříve odhlásil upozornění. Obnovení potvrď přes odkaz pro správu; do té doby ti nic neposíláme." />
        <UButton color="primary" class="min-h-11 w-full sm:w-auto" :loading="isReactivating" :disabled="isReactivating" @click="reactivate">Znovu aktivovat odběr</UButton>
      </section>

      <section v-else class="space-y-2" aria-label="Nastavení komunit">
        <UCollapsible v-for="community in currentCommunities" :key="community.slug" :data-community-slug="community.slug" class="border-b border-default py-2">
          <template #default="{ open }">
            <button type="button" class="flex min-h-11 w-full min-w-0 flex-col items-start gap-1 rounded-md px-2 py-2 text-left hover:bg-elevated focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:flex-row sm:items-center sm:justify-between">
              <span class="min-w-0 break-words font-semibold">{{ community.title }}</span>
              <span class="min-w-0 break-words text-sm text-muted">{{ frequencySummary(community.frequencies) }}</span>
              <span class="sr-only">{{ open ? 'Skrýt nastavení komunity' : 'Zobrazit nastavení komunity' }}</span>
            </button>
          </template>
          <template #content>
            <div class="space-y-4 px-2 py-4">
              <div class="space-y-3">
                <UCheckbox
                  v-for="choice in frequencyChoices"
                  :key="choice.value"
                  :model-value="draftFrequencies(community).includes(choice.value)"
                  :label="choice.label"
                  :disabled="pendingRows.has(community.slug)"
                  @update:model-value="checked => toggleDraftFrequency(community, choice.value, checked)"
                />
              </div>
              <p v-if="!draftFrequencies(community).length" class="text-sm text-error" role="alert">Vyber alespoň jednu frekvenci.</p>
              <div class="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                <UButton color="neutral" variant="outline" class="min-h-11 w-full sm:w-auto" :loading="pendingRows.has(community.slug)" :disabled="pendingRows.has(community.slug) || !draftFrequencies(community).length" @click="saveCommunity(community, draftFrequencies(community))">Uložit změny</UButton>
                <UButton color="neutral" variant="link" class="min-h-11 w-full sm:w-auto" :disabled="pendingRows.has(community.slug)" @click="removeCommunity(community)">Odebrat komunitu</UButton>
              </div>
            </div>
          </template>
        </UCollapsible>
      </section>

      <section class="space-y-4 border-t border-default pt-6">
        <h2 class="text-lg font-semibold">Ukončit odběr</h2>
        <p class="text-sm text-muted">Přestaneš dostávat všechna upozornění v tomto kanálu.</p>
        <UButton ref="stop-trigger" data-testid="notification-stop-trigger" color="error" variant="link" class="min-h-11 w-full justify-start px-0 sm:w-auto" @click="stopOpen = true">Ukončit odběr</UButton>
      </section>

      <UModal v-model:open="stopOpen" title="Ukončit odběr" @after:leave="focusStopTrigger">
        <template #body>
          <p>Opravdu chceš ukončit odběr {{ channelLabel }}? Přestaneme ti posílat všechna upozornění v tomto kanálu.</p>
        </template>
        <template #footer>
          <UButton color="neutral" variant="outline" :disabled="isStopping" @click="stopOpen = false">Neukončovat</UButton>
          <UButton color="error" :loading="isStopping" :disabled="isStopping" @click="stopChannel">Ukončit odběr</UButton>
        </template>
      </UModal>
    </template>
  </main>
</template>
