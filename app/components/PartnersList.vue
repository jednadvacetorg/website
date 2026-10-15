<script setup lang="ts">
import type { Partner } from '#shared/data/partners'
import { otherPartners, partners } from '#shared/data/partners'

const { logoOnly = false, names, other = false } = defineProps<{
  logoOnly?: boolean
  names?: string
  other?: boolean
}>()

const displayedPartners = computed<readonly Partner[]>(() => {
  const selectedPartners: readonly Partner[] = other ? otherPartners : partners
  if (!names) return selectedPartners

  const selectedNames = names.split(',').map(name => name.trim())
  return selectedPartners.filter(partner => selectedNames.includes(partner.name))
})
</script>

<template>
  <ul
    class="grid"
    :class="logoOnly ? 'grid-cols-1 gap-2 lg:grid-cols-2' : 'grid-cols-1 gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-4'"
  >
    <li v-for="partner in displayedPartners" :key="partner.name" class="min-w-0">
      <ULink
        v-if="logoOnly"
        :to="partner.href"
        target="_blank"
        rel="noopener noreferrer"
        :aria-label="`${partner.name}. Otevře se v novém okně.`"
        class="flex h-full min-h-14 items-center justify-center px-2 py-2"
      >
        <NuxtImg
          :src="partner.logo"
          alt=""
          :width="partner.logoWidth"
          :height="partner.logoHeight"
          sizes="160px"
          class="h-10 w-full object-contain"
          :class="partner.logoDark ? 'dark:hidden' : undefined"
          aria-hidden="true"
        />
        <NuxtImg
          v-if="partner.logoDark"
          :src="partner.logoDark"
          alt=""
          :width="partner.logoWidth"
          :height="partner.logoHeight"
          sizes="160px"
          class="hidden h-10 w-full object-contain dark:block"
          aria-hidden="true"
        />
      </ULink>

      <ULink
        v-else
        :to="partner.href"
        target="_blank"
        rel="noopener noreferrer"
        :aria-label="`${partner.name}: ${partner.caption}. Otevře se v novém okně.`"
        class="group flex h-full flex-col items-center text-center transition-transform duration-200 hover:scale-105 motion-reduce:transform-none"
      >
        <NuxtImg
          :src="partner.logo"
          alt=""
          :width="partner.logoWidth"
          :height="partner.logoHeight"
          sizes="160px"
          class="h-12 w-full object-contain"
          :class="partner.logoDark ? 'dark:hidden' : undefined"
          aria-hidden="true"
        />
        <NuxtImg
          v-if="partner.logoDark"
          :src="partner.logoDark"
          alt=""
          :width="partner.logoWidth"
          :height="partner.logoHeight"
          sizes="160px"
          class="hidden h-12 w-full object-contain dark:block"
          aria-hidden="true"
        />
        <span class="mt-4 flex items-center gap-1.5 text-sm text-muted group-hover:underline">
          {{ partner.caption }}
          <UIcon name="i-lucide-external-link" class="size-4 shrink-0" aria-hidden="true" />
        </span>
      </ULink>
    </li>
  </ul>
</template>
