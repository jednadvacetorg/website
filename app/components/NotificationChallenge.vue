<script lang="ts">
type TurnstileOptions = {
  sitekey: string
  action: string
  size: 'flexible' | 'compact'
  'response-field': false
  callback: (token: string) => void
  'expired-callback': () => void
  'error-callback': () => boolean
  'timeout-callback': () => void
}
type Turnstile = {
  render: (container: HTMLElement, options: TurnstileOptions) => string | undefined
  reset: (id: string) => void
  remove: (id: string) => void
}
const getTurnstile = () => (window as Window & { turnstile?: Turnstile }).turnstile
// Shared only at this component boundary; the last pending consumer cancels loading.
let loading: { promise: Promise<Turnstile>, users: number, cancel: () => void } | undefined
const acquireScript = () => {
  if (!loading) {
    const script = document.createElement('script')
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
    script.async = true
    let cancel = () => {}
    const promise = new Promise<Turnstile>((resolve, reject) => {
      let settled = false
      const finish = (api?: Turnstile) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        script.removeEventListener('load', ready)
        script.removeEventListener('error', failed)
        if (api) resolve(api)
        else { script.remove(); loading = undefined; reject(new Error('Challenge unavailable')) }
      }
      const ready = () => {
        const api = getTurnstile()
        if (api) finish(api)
        else finish()
      }
      const failed = () => finish()
      const timeout = setTimeout(failed, 15_000)
      cancel = failed
      script.addEventListener('load', ready)
      script.addEventListener('error', failed)
      document.head.append(script)
    })
    loading = { promise, users: 0, cancel }
  }
  const current = loading
  current.users++
  return { promise: current.promise, release: () => { if (--current.users === 0) current.cancel() } }
}
</script>

<script setup lang="ts">
const props = defineProps<{ siteKey: string, resetKey: number, label?: string }>()
const token = defineModel<string>({ required: true })
const container = useTemplateRef<HTMLElement>('container')
const failure = ref<string | null>(null)
const pending = ref(true)
let mounted = false
let generation = 0
let widget: { api: Turnstile, id: string } | undefined
let releaseScript: (() => void) | undefined

const dispose = () => {
  generation++
  token.value = ''
  if (widget) { widget.api.remove(widget.id); widget = undefined }
  releaseScript?.()
  releaseScript = undefined
}
const render = async () => {
  dispose()
  if (!mounted || !container.value) return
  const owner = generation
  failure.value = null
  pending.value = true
  if (!props.siteKey) {
    failure.value = 'Ověření teď není dostupné. Zkus to prosím později.'
    pending.value = false
    return
  }
  try {
    let api = getTurnstile()
    if (!api) {
      const script = acquireScript()
      releaseScript = script.release
      api = await script.promise
    }
    if (!mounted || owner !== generation || !container.value) return
    const invalidate = (message: string) => {
      if (owner !== generation || !mounted) return
      token.value = ''
      failure.value = message
      // A new render gives callbacks a new owner; late successes cannot revive a token.
      generation++
      if (widget) { widget.api.reset(widget.id); widget.api.remove(widget.id); widget = undefined }
    }
    const id = api.render(container.value, {
      sitekey: props.siteKey,
      action: 'notification-operation',
      // Flexible has a native 300px minimum; padded 320px forms need compact.
      size: container.value.clientWidth < 300 ? 'compact' : 'flexible',
      'response-field': false,
      callback: value => { if (mounted && owner === generation) { token.value = value; failure.value = null } },
      'expired-callback': () => invalidate('Ověření vypršelo. Ověř požadavek znovu.'),
      'error-callback': () => { invalidate('Ověření se nepodařilo. Zkus ho znovu.'); return true },
      'timeout-callback': () => invalidate('Čas na ověření vypršel. Zkus ho znovu.'),
    })
    if (!id) throw new Error('Challenge unavailable')
    widget = { api, id }
  } catch {
    if (mounted && owner === generation) failure.value = 'Ověření se nepodařilo načíst. Zkus ho znovu.'
  } finally {
    if (mounted && owner === generation) pending.value = false
  }
}
watch(() => [props.resetKey, props.siteKey], () => { if (mounted) void render() }, { flush: 'sync' })
onMounted(() => { mounted = true; void render() })
onBeforeUnmount(() => { mounted = false; dispose() })
</script>

<template>
  <UFormField :label="label ?? 'Ověřit požadavek'" help="Počkej alespoň minutu od posledního pokusu. Pak dokonči ověření a zkus požadavek odeslat znovu.">
    <div ref="container" />
    <p v-if="pending" role="status">Načítáme ověření…</p>
    <UAlert v-if="failure" class="my-4" color="warning" :title="failure" role="alert" />
    <UButton v-if="failure && siteKey" type="button" color="neutral" variant="outline" @click="render">Zkusit ověření znovu</UButton>
  </UFormField>
</template>
