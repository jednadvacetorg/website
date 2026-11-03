<script setup lang="ts">
import { podcast } from '#shared/data/social'
</script>

<template>
  <div class="flex flex-wrap items-center gap-1">
    <span class="text-sm text-muted">Přihlas se k odběru:</span>
    <UTooltip v-for="(platform, key) in podcast.platforms" :key="key" :text="platform.label" arrow>
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
