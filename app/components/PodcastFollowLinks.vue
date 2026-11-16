<script setup lang="ts">
import { podcast } from '#shared/data/social'

const copied = shallowRef(false)
const rssTooltipOpen = shallowRef(false)

function resetRssTooltip() {
  copied.value = false
  rssTooltipOpen.value = false
}

async function copyRssLink(event: MouseEvent) {
  if (!navigator.clipboard?.writeText || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return

  event.preventDefault()
  const link = event.currentTarget as HTMLElement
  link.focus()
  const url = new URL(podcast.platforms.rss.to, window.location.href).href
  try {
    await navigator.clipboard.writeText(url)
    if (document.activeElement === link) copied.value = true
  } catch {
    window.location.assign(url)
  }
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-1">
    <span class="text-sm text-muted">Přihlas se k odběru:</span>
    <UTooltip
      v-for="(platform, key) in podcast.platforms"
      :key="key"
      :text="key === 'rss' && copied ? 'Odkaz zkopírován' : platform.label"
      :open="key === 'rss' ? copied || rssTooltipOpen : undefined"
      :ui="key === 'rss' ? { content: 'h-auto max-w-xs', text: 'whitespace-normal' } : undefined"
      arrow
      @update:open="key === 'rss' && (rssTooltipOpen = $event)"
    >
      <template v-if="key === 'rss' && copied" #content>
        <span>Odkaz zkopírován</span>
        <UIcon name="i-lucide-check" class="size-4 shrink-0" aria-hidden="true" />
      </template>
      <template #default>
        <span :tabindex="platform.to ? undefined : 0">
          <UButton
            :icon="'icon' in platform ? platform.icon : undefined"
            :to="platform.to"
            external
            :target="platform.to?.startsWith('https://') ? '_blank' : undefined"
            :disabled="!platform.to"
            :aria-label="platform.label"
            color="neutral"
            variant="ghost"
            size="xs"
            @click="key === 'rss' && copyRssLink($event)"
            @blur="key === 'rss' && resetRssTooltip()"
          >
            <template v-if="'image' in platform" #leading>
              <img :src="platform.image" alt="" class="size-4" width="16" height="16">
            </template>
          </UButton>
        </span>
      </template>
    </UTooltip>
  </div>
</template>
