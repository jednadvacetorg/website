<script setup lang="ts">
import { partners } from '~~/content/data/partners'
</script>

<template>
  <div class="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
    <a
      v-for="p in partners"
      :key="p.name"
      :href="p.href"
      target="_blank"
      rel="noopener noreferrer"
      class="group flex flex-col gap-3 rounded-xl border border-gray-200 dark:border-gray-800 hover:border-primary/50 dark:hover:border-primary/50 bg-gray-50 dark:bg-gray-950/50 hover:bg-gray-100 dark:hover:bg-gray-900 transition-colors p-5"
    >
      <img
        :src="p.logo"
        :alt="p.name"
        :width="p.logoWidth"
        :height="p.logoHeight"
        class="h-8 w-auto self-start object-contain"
        :class="{ 'dark:hidden': p.logoDark }"
      />
      <img
        v-if="p.logoDark"
        :src="p.logoDark"
        :alt="p.name"
        :width="p.logoWidth"
        :height="p.logoHeight"
        class="h-8 w-auto self-start object-contain hidden dark:block"
      />
      <div>
        <p class="font-semibold group-hover:text-primary transition-colors">{{ p.name }}</p>
        <p class="text-sm text-gray-500 dark:text-gray-400">{{ p.caption }}</p>
      </div>
    </a>
  </div>
</template>
