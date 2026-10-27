<script setup lang="ts">
const { initialCommunity, directEntry = false } = defineProps<{
  initialCommunity?: string
  directEntry?: boolean
}>()
const { $counterscale } = useNuxtApp()

const wholeCountryValue = 'all-czech-communities'
const falseReadinessMessage = 'Tato možnost ještě není připravená. Nic jsme neaktivovali; už teď můžeš odebírat kalendář přes iCalendar.'
const interestConfirmation = 'Promiň, tato možnost ještě není připravená, takže jsme nic neaktivovali. Sleduj prosím naše sociální sítě; už teď můžeš odebírat kalendář přes iCalendar.'
const temporaryUnavailableMessage = 'Tato možnost je teď dočasně nedostupná. Nic jsme neaktivovali; zkus to prosím později.'
const { public: publicConfig } = useRuntimeConfig()
const readiness = ref({ email: false, sms: false, webPush: false })
const isReadinessLoading = ref(false)
let readinessRequest = 0

const refreshReadiness = async () => {
  const request = ++readinessRequest
  readiness.value = { email: false, sms: false, webPush: false }
  turnstileToken.value = ''
  recoveryTurnstileToken.value = ''
  activationChallengeRevision.value++
  recoveryChallengeRevision.value++
  pushChallengeRevision.value++
  pushRecoveryChallengeRevision.value++
  isActivating.value = false
  isRecovering.value = false
  pushActivationRequest = undefined
  pushRecoveryContact = undefined
  webPushState.value = null
  pushRecoveryState.value = null
  isWebPushActivating.value = false
  isPushRecovering.value = false
  pushChallengeRequired.value = false
  pushRecoveryChallengeRequired.value = false
  pushTurnstileToken.value = ''
  pushRecoveryTurnstileToken.value = ''
  isReadinessLoading.value = true
  try {
    const result = await $fetch<{ email: boolean, sms: boolean, webPush: boolean }>('/api/notifications/readiness', { cache: 'no-store', retry: 0 })
    if (request !== readinessRequest) return
    readiness.value = { email: result.email === true, sms: result.sms === true, webPush: result.webPush === true }
  } catch {
    // Loading and failed reads never authorize activation.
  } finally {
    if (request === readinessRequest) isReadinessLoading.value = false
  }
}

const refreshVisibleReadiness = () => {
  if (document.visibilityState === 'visible') void refreshReadiness()
}
// These browser-only convenience values belong exclusively to false-readiness
// fake doors and never cross the activation, recovery, or analytics boundary.
const storedTelephone = useLocalStorage<string | null>('subscription-guide-telephone', null, { initOnMounted: true })
const storedEmail = useLocalStorage<string | null>('subscription-guide-email', null, { initOnMounted: true })
const fakeTelephone = computed({
  get: () => storedTelephone.value ?? '',
  set: value => { storedTelephone.value = value || null },
})
const fakeEmail = computed({
  get: () => storedEmail.value ?? '',
  set: value => { storedEmail.value = value || null },
})
const telephone = ref('')
const email = ref('')
const recoveryContact = ref('')
const activeMethod = ref<'sms' | 'email' | null>(null)
const recoveryMethod = ref<'sms' | 'email' | null>(null)
const recoveryOpen = ref(false)
const activationState = ref<Record<'sms' | 'email', 'active' | 'updated' | 'pending-reactivation' | 'error' | null>>({ sms: null, email: null })
const recoveryState = ref<'success' | 'error' | null>(null)
const isActivating = ref(false)
const isRecovering = ref(false)
const challengeRequired = ref(false)
const turnstileToken = ref('')
const recoveryChallengeRequired = ref(false)
const recoveryTurnstileToken = ref('')
const webPushState = ref<'active' | 'updated' | 'pending-reactivation' | 'default' | 'unsupported' | 'denied' | 'install' | 'error' | 'rate-limited' | null>(null)
const isWebPushActivating = ref(false)
const pushChallengeRequired = ref(false)
const pushTurnstileToken = ref('')
const pushRecoveryState = ref<'success' | 'error' | 'rate-limited' | null>(null)
const isPushRecovering = ref(false)
const pushRecoveryChallengeRequired = ref(false)
const pushRecoveryTurnstileToken = ref('')
const activationChallengeRevision = ref(0)
const recoveryChallengeRevision = ref(0)
const pushChallengeRevision = ref(0)
const pushRecoveryChallengeRevision = ref(0)
// A challenge retries this same device/request, never a fresh permission prompt.
let pushActivationRequest: { channel: 'web-push', contact: PushSubscriptionJSON, communitySlugs: string[], frequencies: FrequencyValue[], consentAt: string, consentVersion: string } | undefined
let pushRecoveryContact: PushSubscriptionJSON | undefined

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
// Serialize the server origin so the first client render matches prerendered text.
const { data: currentOrigin } = await useAsyncData('subscription-guide-origin', () => Promise.resolve(useRequestURL().origin))
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
const hasTelephone = computed(() => /^\+[1-9]\d{7,14}$/.test(telephone.value.trim()))
const hasEmail = computed(() => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim()))
const hasFakeTelephone = computed(() => fakeTelephone.value.trim().length > 0)
const hasFakeEmail = computed(() => fakeEmail.value.trim().length > 0)
const hasRecoveryTelephone = computed(() => /^\+[1-9]\d{7,14}$/.test(recoveryContact.value.trim()))
const hasRecoveryEmail = computed(() => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recoveryContact.value.trim()))
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
watch([telephone, email, activeMethod, selectedCommunitySlugs, selectedFrequencies], () => {
  turnstileToken.value = ''
  activationChallengeRevision.value++
  isActivating.value = false
}, { deep: true, flush: 'sync' })
watch([recoveryContact, recoveryMethod, recoveryOpen, selectedCommunitySlugs, selectedFrequencies], () => {
  recoveryTurnstileToken.value = ''
  recoveryChallengeRevision.value++
  isRecovering.value = false
  recoveryState.value = null
}, { deep: true, flush: 'sync' })
watch([selectedCommunitySlugs, selectedFrequencies], () => {
  pushRecoveryTurnstileToken.value = ''
  pushRecoveryChallengeRevision.value++
  isPushRecovering.value = false
}, { deep: true, flush: 'sync' })
watch([selectedCommunitySlugs, selectedFrequencies], () => {
  pushTurnstileToken.value = ''
  pushChallengeRevision.value++
  if (pushActivationRequest) {
    pushActivationRequest = { ...pushActivationRequest, communitySlugs: [...notificationScope.value], frequencies: [...selectedFrequencies.value] }
  }
  isWebPushActivating.value = false
}, { deep: true, flush: 'sync' })
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
    channel: 'sms',
    title: 'SMS',
    description: 'Upozornění na vybrané události dostaneš jako SMS.',
  },
  {
    channel: 'email',
    title: 'E-mail',
    description: 'Upozornění e-mailem může obsahovat událost, kterou si přidáš do vlastního kalendáře.',
  },
  {
    channel: 'web-push',
    title: 'Webové notifikace',
    description: 'Upozornění dostaneš přímo v tomto prohlížeči.',
  },
] as const

const retryCommunities = () => refresh()

const isMethodReady = (method: 'sms' | 'email' | 'web-push') => readiness.value?.[method === 'web-push' ? 'webPush' : method] === true
const vapidPublicKey = computed(() => {
  const value = (publicConfig as Record<string, unknown>).notificationVapidPublicKey
  return typeof value === 'string' && /^[A-Za-z0-9_-]{80,120}$/.test(value) ? value : null
})
const enableWebPush = async () => {
  if (!isMethodReady('web-push') || !hasSelectedScope.value || !vapidPublicKey.value || isWebPushActivating.value || (pushChallengeRequired.value && !pushTurnstileToken.value)) return
  const request = readinessRequest
  const revision = pushChallengeRevision.value
  const current = () => request === readinessRequest && revision === pushChallengeRevision.value && isMethodReady('web-push')
  isWebPushActivating.value = true
  webPushState.value = null
  try {
    if (pushActivationRequest && 'Notification' in window && Notification.permission !== 'granted') {
      webPushState.value = Notification.permission === 'denied' ? 'denied' : 'default'
      pushActivationRequest = undefined
      pushChallengeRequired.value = false
      return
    }
    if (!pushChallengeRequired.value || !pushActivationRequest) {
      const iosHint = /iP(?:hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
      const installed = window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true
      if (iosHint && !installed && !('PushManager' in window)) { webPushState.value = 'install'; return }
      if (!window.isSecureContext || !('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) { webPushState.value = 'unsupported'; return }
      if (Notification.permission === 'denied') { webPushState.value = 'denied'; return }
      // requestPermission starts synchronously in the click handler, before any await.
      const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission()
       if (!current()) return
      if (permission !== 'granted') { webPushState.value = permission === 'denied' ? 'denied' : 'default'; return }
      await navigator.serviceWorker.register('/notification-sw.js', { scope: '/' })
       if (!current()) return
      const registration = await navigator.serviceWorker.ready
       if (!current()) return
      const bytes = Uint8Array.from(atob(vapidPublicKey.value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - vapidPublicKey.value.length % 4) % 4)), character => character.charCodeAt(0))
      let subscription = await registration.pushManager.getSubscription()
       if (!current()) return
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes })
         if (!current()) return
      }
      pushActivationRequest = { channel: 'web-push', contact: subscription.toJSON(), communitySlugs: [...notificationScope.value], frequencies: [...selectedFrequencies.value], consentAt: new Date().toISOString(), consentVersion: '2026-09' }
    }
    if (!current()) return
    const result = await $fetch<{ state: 'active' | 'updated' | 'pending-reactivation' }>('/api/notifications/activate', { method: 'POST', retry: 0, body: { ...pushActivationRequest, ...(pushTurnstileToken.value ? { turnstileToken: pushTurnstileToken.value } : {}) } })
    if (!current()) return
    if (!['active', 'updated', 'pending-reactivation'].includes(result.state)) throw new Error('Unexpected activation response')
    webPushState.value = result.state
    pushChallengeRequired.value = false
    pushActivationRequest = undefined
  } catch (error) {
    if (!current()) return
    const code = (error as { statusCode?: number }).statusCode
    pushChallengeRequired.value = pushChallengeRequired.value || code === 403
    webPushState.value = code === 429 ? 'rate-limited' : 'error'
    if (!pushChallengeRequired.value) pushActivationRequest = undefined
  } finally {
    if (current()) { pushTurnstileToken.value = ''; isWebPushActivating.value = false; pushChallengeRevision.value++ }
  }
}
const requestPushRecovery = async () => {
  if (!isMethodReady('web-push') || isPushRecovering.value || (pushRecoveryChallengeRequired.value && !pushRecoveryTurnstileToken.value)) return
  const request = readinessRequest
  const revision = pushRecoveryChallengeRevision.value
  const current = () => request === readinessRequest && revision === pushRecoveryChallengeRevision.value && isMethodReady('web-push')
  isPushRecovering.value = true
  pushRecoveryState.value = null
  try {
    if (!pushRecoveryChallengeRequired.value || !pushRecoveryContact) {
      pushRecoveryContact = undefined
      if (window.isSecureContext && 'serviceWorker' in navigator) {
        const registration = await navigator.serviceWorker.getRegistration('/')
        if (!current()) return
        const subscription = await registration?.pushManager.getSubscription()
        if (!current()) return
        pushRecoveryContact = subscription?.toJSON()
      }
    }
    if (!current()) return
    if (pushRecoveryContact) await $fetch('/api/notifications/manage-request', { method: 'POST', retry: 0, body: { channel: 'web-push', contact: pushRecoveryContact, ...(pushRecoveryTurnstileToken.value ? { turnstileToken: pushRecoveryTurnstileToken.value } : {}) } })
    if (!current()) return
    pushRecoveryState.value = 'success'
    pushRecoveryChallengeRequired.value = false
    pushRecoveryContact = undefined
  } catch (error) {
    if (!current()) return
    const code = (error as { statusCode?: number }).statusCode
    pushRecoveryChallengeRequired.value = pushRecoveryChallengeRequired.value || code === 403
    pushRecoveryState.value = code === 429 ? 'rate-limited' : 'error'
    if (!pushRecoveryChallengeRequired.value) pushRecoveryContact = undefined
  } finally {
    if (current()) { pushRecoveryTurnstileToken.value = ''; isPushRecovering.value = false; pushRecoveryChallengeRevision.value++ }
  }
}
const expressSmsInterest = () => {
  $counterscale.trackSmsIntent()
  window.alert(interestConfirmation)
}
const expressEmailInterest = () => {
  $counterscale.trackEmailIntent()
  window.alert(interestConfirmation)
}
const expressWebInterest = () => {
  $counterscale.trackWebIntent()
  window.alert(interestConfirmation)
}
const methodContact = (method: 'sms' | 'email') => method === 'sms' ? telephone.value : email.value
const validMethodContact = (method: 'sms' | 'email') => method === 'sms' ? hasTelephone.value : hasEmail.value
const validRecoveryContact = (method: 'sms' | 'email') => method === 'sms' ? hasRecoveryTelephone.value : hasRecoveryEmail.value
const notificationScope = computed(() => selectedCommunitySlugs.value.includes(wholeCountryValue)
  ? selectedCommunities.value.map(community => community.path.replace(/^\//, ''))
  : selectedCommunitySlugs.value)

const activate = async (method: 'sms' | 'email') => {
  if (!isMethodReady(method) || !hasSelectedScope.value || !validMethodContact(method) || isActivating.value || (challengeRequired.value && !turnstileToken.value)) return
  const revision = activationChallengeRevision.value
  isActivating.value = true
  activationState.value[method] = null
  try {
    const result = await $fetch<{ state: 'active' | 'updated' | 'pending-reactivation' }>('/api/notifications/activate', {
      method: 'POST',
      retry: 0,
      body: {
        channel: method,
        contact: methodContact(method),
        communitySlugs: notificationScope.value,
        frequencies: selectedFrequencies.value,
        consentAt: new Date().toISOString(),
        consentVersion: '2026-09',
        ...(turnstileToken.value ? { turnstileToken: turnstileToken.value } : {}),
      },
    })
    if (revision !== activationChallengeRevision.value) return
    activationState.value[method] = result.state
    challengeRequired.value = false
  } catch (error) {
    if (revision !== activationChallengeRevision.value) return
    challengeRequired.value = challengeRequired.value || (error as { statusCode?: number }).statusCode === 403
    turnstileToken.value = ''
    activationState.value[method] = 'error'
  } finally {
    if (revision === activationChallengeRevision.value) {
      isActivating.value = false
      turnstileToken.value = ''
      activationChallengeRevision.value++
    }
  }
}

const requestRecovery = async (method: 'sms' | 'email') => {
  if (!isMethodReady(method) || !validRecoveryContact(method) || isRecovering.value || (recoveryChallengeRequired.value && !recoveryTurnstileToken.value)) return
  const revision = recoveryChallengeRevision.value
  isRecovering.value = true
  recoveryState.value = null
  try {
    await $fetch('/api/notifications/manage-request', { method: 'POST', retry: 0, body: { channel: method, contact: recoveryContact.value, ...(recoveryTurnstileToken.value ? { turnstileToken: recoveryTurnstileToken.value } : {}) } })
    if (revision !== recoveryChallengeRevision.value) return
    recoveryState.value = 'success'
    recoveryChallengeRequired.value = false
    recoveryTurnstileToken.value = ''
  } catch (error) {
    if (revision !== recoveryChallengeRevision.value) return
    recoveryChallengeRequired.value = recoveryChallengeRequired.value || (error as { statusCode?: number }).statusCode === 403
    recoveryTurnstileToken.value = ''
    recoveryState.value = 'error'
  } finally {
    if (revision === recoveryChallengeRevision.value) {
      isRecovering.value = false
      recoveryTurnstileToken.value = ''
      recoveryChallengeRevision.value++
    }
  }
}

const copyCalendarUrl = async (url: string) => {
  copyError.value = null
  $counterscale.trackICalendarCopy()

  try {
    await navigator.clipboard.writeText(url)
    copiedCalendarUrl.value = url
  } catch {
    copiedCalendarUrl.value = null
    copyError.value = 'Adresu se nepodařilo zkopírovat. Označ ji a zkopíruj ručně.'
  }
}

onMounted(() => {
  currentOrigin.value = window.location.origin
  void refreshReadiness()
  document.addEventListener('visibilitychange', refreshVisibleReadiness)
  if (directEntry) $counterscale.trackSubscriptionGuide()
})

onBeforeUnmount(() => {
  readinessRequest++
  activationChallengeRevision.value++
  recoveryChallengeRevision.value++
  document.removeEventListener('visibilitychange', refreshVisibleReadiness)
})
</script>

<template>
  <section
    class="mx-auto w-full min-w-0 max-w-3xl space-y-8"
    :aria-labelledby="directEntry ? 'subscription-guide-title' : undefined"
  >
    <div v-if="directEntry" class="space-y-2">
      <h2 id="subscription-guide-title" class="text-3xl font-semibold leading-tight">Sledovat události</h2>
      <p>Vyber si komunity a způsob, jakým chceš jejich události sledovat.</p>
    </div>

    <div class="space-y-2">
      <label for="subscription-community-scope" class="text-sm font-semibold">Komunity, které chceš sledovat</label>
      <USelectMenu
        id="subscription-community-scope"
        :model-value="selectedCommunitySlugs"
        :items="communityOptions"
        value-key="value"
        multiple
        clear
        :disabled="status === 'pending' || status === 'error' || !communities"
        :search-input="{ placeholder: 'Hledat komunitu…' }"
        aria-label="Komunity, které chceš sledovat"
        placeholder="Vyber komunity"
        class="w-full"
        @update:model-value="updateCommunityScope"
      />
      <p v-if="status === 'pending'" role="status" class="text-sm text-muted">Načítáme komunity…</p>
      <div v-else-if="status === 'error' || !communities" class="space-y-3" role="alert">
        <p class="text-sm text-muted">Komunity se nyní nepodařilo načíst. Obnov stránku a zkus to znovu.</p>
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
        <p class="text-sm font-semibold">Kdy chceš dostávat upozornění?</p>
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
        <h3 class="text-xl font-semibold leading-tight">Vyber alespoň jednu komunitu</h3>
        <p class="mt-2 text-sm text-muted">Potom ti ukážeme dostupné možnosti sledování a adresu kalendáře.</p>
      </div>

      <UAlert v-if="isReadinessLoading" color="neutral" title="Ověřujeme dostupné možnosti upozornění…" role="status" />

      <template v-for="(method, index) in futureMethods" :key="method.title">
        <section class="space-y-4">
          <h3 class="text-xl font-semibold leading-tight">{{ method.title }}</h3>
          <p>{{ method.description }}</p>
          <p v-if="method.channel === 'web-push'" class="text-sm text-muted">
            Tato možnost je pro Jednadvacet nejlevnější a pro tebe nejsoukromější.
            <UPopover mode="hover" enable-touch :ui="{ content: 'max-w-xs p-4 text-sm' }">
              <UButton icon="i-lucide-info" color="neutral" variant="link" aria-label="Proč jsou webové notifikace levnější a soukromější" />
              <template #content>
                <p>Odesílání SMS a e-mailů může Jednadvacet stát drobné poplatky a vyžaduje uložit tvůj kontakt do databáze. Za jednotlivé webové notifikace poskytovateli rozesílky neplatíme a místo e-mailu či telefonu ukládáme technické údaje odběru tohoto prohlížeče.</p>
              </template>
            </UPopover>
          </p>

          <template v-if="method.title === 'SMS'">
            <template v-if="isMethodReady('sms')">
              <UFormField label="Telefonní číslo" name="telephone" :error="telephone && !hasTelephone ? 'Zadej telefonní číslo v mezinárodním formátu, například +420123456789.' : undefined">
                <UInput
                  v-model="telephone"
                  type="tel"
                  autocomplete="tel"
                  class="w-full"
                  :disabled="isActivating"
                />
              </UFormField>
              <div class="flex flex-wrap items-center justify-between gap-2">
                <UButton color="primary" class="min-h-11 w-full sm:w-auto" :loading="isActivating && activeMethod === 'sms'" :disabled="!hasSelectedScope || !hasTelephone || isActivating || (challengeRequired && !turnstileToken)" @click="activeMethod = 'sms'; activate('sms')">Aktivovat odběr</UButton>
                <UButton color="neutral" variant="link" class="ms-auto min-h-11" aria-label="Spravovat SMS notifikace" @click="recoveryMethod = 'sms'; recoveryOpen = true">Spravovat notifikace</UButton>
              </div>
            </template>
            <template v-else>
              <UFormField label="Telefonní číslo" name="telephone">
                <UInput v-model="fakeTelephone" type="tel" autocomplete="tel" class="w-full" />
              </UFormField>
              <UButton color="neutral" class="min-h-11 w-full sm:w-auto" :disabled="!hasSelectedScope || !hasFakeTelephone" @click="expressSmsInterest">Mám zájem o SMS</UButton>
              <p role="status" class="text-sm text-muted">{{ falseReadinessMessage }}</p>
            </template>
          </template>

          <template v-else-if="method.title === 'E-mail'">
            <template v-if="isMethodReady('email')">
              <UFormField label="E-mail" name="email" :error="email && !hasEmail ? 'Zadej platný e-mail.' : undefined">
                <UInput
                  v-model="email"
                  type="email"
                  autocomplete="email"
                  class="w-full"
                  :disabled="isActivating"
                />
              </UFormField>
              <div class="flex flex-wrap items-center justify-between gap-2">
                <UButton color="primary" class="min-h-11 w-full sm:w-auto" :loading="isActivating && activeMethod === 'email'" :disabled="!hasSelectedScope || !hasEmail || isActivating || (challengeRequired && !turnstileToken)" @click="activeMethod = 'email'; activate('email')">Aktivovat odběr</UButton>
                <UButton color="neutral" variant="link" class="ms-auto min-h-11" aria-label="Spravovat e-mailové notifikace" @click="recoveryMethod = 'email'; recoveryOpen = true">Spravovat notifikace</UButton>
              </div>
            </template>
            <template v-else>
              <UFormField label="E-mail" name="email">
                <UInput v-model="fakeEmail" type="email" autocomplete="email" class="w-full" />
              </UFormField>
              <UButton color="neutral" class="min-h-11 w-full sm:w-auto" :disabled="!hasSelectedScope || !hasFakeEmail" @click="expressEmailInterest">Mám zájem o e-mail</UButton>
              <p role="status" class="text-sm text-muted">{{ falseReadinessMessage }}</p>
            </template>
          </template>

          <template v-else>
            <template v-if="isMethodReady('web-push') && vapidPublicKey">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <UButton color="primary" class="min-h-11 w-full sm:w-auto" :loading="isWebPushActivating" :disabled="!hasSelectedScope || isWebPushActivating || (pushChallengeRequired && !pushTurnstileToken)" @click="enableWebPush">Aktivovat webové notifikace</UButton>
                <UButton color="neutral" variant="link" class="ms-auto min-h-11" :loading="isPushRecovering" :disabled="isPushRecovering || (pushRecoveryChallengeRequired && !pushRecoveryTurnstileToken)" @click="requestPushRecovery">Poslat odkaz pro správu tohoto prohlížeče</UButton>
              </div>
              <UAlert v-if="webPushState === 'active'" color="success" title="Oznámení jsou pro tento prohlížeč aktivní. Odkaz pro správu ti pošleme v první zprávě." role="status" />
              <UAlert v-else-if="webPushState === 'updated'" color="success" title="Nastavení oznámení jsme aktualizovali." role="status" />
              <UAlert v-else-if="webPushState === 'pending-reactivation'" color="warning" title="Obnovení potvrď přes odkaz pro správu. Do té doby ti upozornění na akce neposíláme." role="status" />
              <UAlert v-else-if="webPushState === 'default'" color="neutral" title="Oznámení jsi zatím nepovolil. Nic jsme neaktivovali; můžeš to zkusit znovu." role="status" />
              <UAlert v-else-if="webPushState === 'denied'" color="warning" title="Oznámení máš v prohlížeči zakázaná. Povol je v jeho nastavení a pak to zkus znovu." role="alert" />
              <UAlert v-else-if="webPushState === 'install'" color="neutral" title="Na iPhonu nebo iPadu si nejdřív přidej web na plochu a otevři ho jako aplikaci." role="status" />
              <UAlert v-else-if="webPushState === 'unsupported'" color="neutral" title="Tento prohlížeč teď oznámení nepodporuje. Můžeš odebírat kalendář přes iCalendar." role="status" />
              <UAlert v-else-if="webPushState === 'rate-limited'" color="warning" title="Počkej prosím alespoň minutu, než to zkusíš znovu." role="alert" />
              <UAlert v-else-if="webPushState === 'error'" color="error" :title="pushChallengeRequired ? 'Nejdřív ověř požadavek a pak aktivaci zkus znovu.' : 'Aktivaci se teď nepodařilo potvrdit. Zkus to prosím později.'" role="alert" />
              <NotificationChallenge v-if="pushChallengeRequired" v-model="pushTurnstileToken" :site-key="publicConfig.notificationTurnstileSiteKey" :reset-key="pushChallengeRevision" label="Ověřit aktivaci oznámení" />
              <UAlert v-if="pushRecoveryState === 'success'" color="neutral" title="Pokud pro tento prohlížeč existuje správa oznámení, pošleme ti odkaz. Bez uloženého odběru není co obnovit." role="status" />
              <UAlert v-else-if="pushRecoveryState === 'rate-limited'" color="warning" title="Počkej prosím alespoň minutu, než požádáš o odkaz znovu." role="alert" />
              <UAlert v-else-if="pushRecoveryState === 'error'" color="error" :title="pushRecoveryChallengeRequired ? 'Nejdřív ověř požadavek a pak požádej o odkaz znovu.' : 'Odkaz se teď nepodařilo vyžádat. Zkus to prosím později.'" role="alert" />
              <NotificationChallenge v-if="pushRecoveryChallengeRequired" v-model="pushRecoveryTurnstileToken" :site-key="publicConfig.notificationTurnstileSiteKey" :reset-key="pushRecoveryChallengeRevision" label="Ověřit správu prohlížeče" />
            </template>
            <template v-else>
              <UButton color="neutral" class="min-h-11 w-full sm:w-auto" :disabled="!hasSelectedScope" @click="expressWebInterest">Mám zájem o webové notifikace</UButton>
              <p role="status" class="text-sm text-muted">{{ falseReadinessMessage }}</p>
            </template>
          </template>
          <template v-if="method.channel !== 'web-push' && isMethodReady(method.channel)">
            <UAlert
              v-if="activationState[method.channel] === 'active'"
              color="success"
              title="Odběr je aktivní. Potvrzení a odkaz pro správu ti pošleme v první zprávě."
              role="status"
              aria-live="polite"
            />
            <UAlert
              v-else-if="activationState[method.channel] === 'updated'"
              color="success"
              title="Nastavení odběru jsme aktualizovali."
              role="status"
              aria-live="polite"
            />
            <UAlert
              v-else-if="activationState[method.channel] === 'pending-reactivation'"
              color="warning"
              title="Tento kontakt už dříve odhlásil upozornění. Obnovení potvrď přes odkaz pro správu; do té doby ti nic neposíláme."
              role="status"
              aria-live="polite"
            />
            <div v-else-if="activationState[method.channel] === 'error'" class="space-y-3" role="alert">
              <UAlert color="error" :title="challengeRequired ? temporaryUnavailableMessage : 'Nastavení se teď nepodařilo uložit. Nic jsme nezměnili. Zkus to prosím znovu.'" />
            </div>
            <NotificationChallenge v-if="challengeRequired && activeMethod === method.channel" v-model="turnstileToken" :site-key="publicConfig.notificationTurnstileSiteKey" :reset-key="activationChallengeRevision" />
          </template>
        </section>
        <USeparator v-if="index < futureMethods.length - 1" label="nebo" />
      </template>

      <USeparator label="nebo" />
      <section class="min-w-0 space-y-4">
        <h3 class="text-xl font-semibold leading-tight">Kalendářový feed</h3>
        <p>Zkopíruj si adresu a přihlas ji k odběru ve své kalendářové aplikaci.</p>
        <p v-if="hasSelectedScope" class="text-sm text-muted">Vybraný rozsah: {{ selectedScopeSummary }}</p>
        <p v-else class="text-sm text-muted">Vyber alespoň jednu komunitu, abys získal adresu kalendáře.</p>

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
          <p>Čas obnovení určuje tvoje kalendářová aplikace.</p>
        </div>

        <div class="flex flex-wrap gap-2" aria-label="Návody pro kalendářové aplikace">
          <UPopover>
            <UButton icon="i-simple-icons-googlecalendar" color="neutral" variant="ghost" class="size-11" aria-label="Google Calendar" title="Google Calendar" />
            <template #content>
              <p class="max-w-sm p-3 text-sm">V Kalendáři Google otevři Další kalendáře → Přidat další kalendáře → Z adresy URL. Vlož zkopírovanou adresu a potvrď Přidat kalendář.</p>
            </template>
          </UPopover>
          <UPopover>
            <UButton icon="i-simple-icons-apple" color="neutral" variant="ghost" class="size-11" aria-label="Apple Kalendář" title="Apple Kalendář" />
            <template #content>
              <p class="max-w-sm p-3 text-sm">iPhone/iPad: Nastavení → Aplikace → Kalendář → Účty kalendáře → Přidat účet → Jiný → Přidat odebíraný kalendář. Mac: Kalendář → Soubor → Nové přihlášení k odběru kalendáře. V obou případech vlož adresu URL.</p>
            </template>
          </UPopover>
          <UPopover>
            <UButton icon="i-simple-icons-microsoftoutlook" color="neutral" variant="ghost" class="size-11" aria-label="Outlook" title="Outlook" />
            <template #content>
              <p class="max-w-sm p-3 text-sm">V Outlooku na webu vyber Přidat kalendář → Přihlásit se k odběru z webu, vlož adresu a ulož. Nevol Importovat kalendář; ten vytvoří jen jednorázovou kopii.</p>
            </template>
          </UPopover>
          <UPopover>
            <UButton icon="i-lucide-circle-help" color="neutral" variant="ghost" class="size-11" aria-label="Jiná aplikace" title="Jiná aplikace" />
            <template #content>
              <p class="max-w-sm p-3 text-sm">V aplikaci hledej volbu jako Přihlásit se k odběru kalendáře, Přidat kalendář z URL nebo Síťový kalendář. Vlož zkopírovanou adresu jako nový odebíraný kalendář.</p>
            </template>
          </UPopover>
        </div>
      </section>
    </div>
  </section>

  <UModal v-model:open="recoveryOpen" title="Spravovat notifikace">
    <template #body>
      <div class="space-y-4">
        <p class="text-sm text-muted">Zadej kontakt pro {{ recoveryMethod === 'sms' ? 'SMS' : 'e-mail' }}.</p>
        <UFormField :label="recoveryMethod === 'sms' ? 'Telefonní číslo' : 'E-mail'" name="recovery-contact">
          <UInput v-model="recoveryContact" :type="recoveryMethod === 'sms' ? 'tel' : 'email'" class="w-full" />
        </UFormField>
        <UAlert v-if="recoveryState === 'success'" color="success" title="Pokud máš na tomto kontaktu odběr, pošleme ti nový odkaz pro správu. Zkontroluj i spam a použij nejnovější odkaz. Pokud zpráva nepřijde, počkej alespoň minutu a zkus to znovu." role="status" aria-live="polite" />
          <UAlert v-else-if="recoveryState === 'error'" color="error" :title="recoveryChallengeRequired ? temporaryUnavailableMessage : 'Odkaz se teď nepodařilo odeslat. Zkus to prosím později.'" role="alert" />
          <NotificationChallenge v-if="recoveryOpen && recoveryChallengeRequired" v-model="recoveryTurnstileToken" :site-key="publicConfig.notificationTurnstileSiteKey" :reset-key="recoveryChallengeRevision" />
      </div>
    </template>
    <template #footer>
      <UButton color="neutral" variant="outline" @click="recoveryOpen = false">Zrušit</UButton>
       <UButton color="neutral" :loading="isRecovering" :disabled="!recoveryMethod || !validRecoveryContact(recoveryMethod) || isRecovering || (recoveryChallengeRequired && !recoveryTurnstileToken)" @click="requestRecovery(recoveryMethod!)">Poslat odkaz pro správu</UButton>
    </template>
  </UModal>
</template>
