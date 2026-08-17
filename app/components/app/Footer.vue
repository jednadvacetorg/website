<script setup lang="ts">
const footerLinks = [
  { label: 'Dvadsaťjeden (SK)', to: 'https://dvadsatjeden.org' },
  { label: 'Twentyone World (EN)', to: 'https://twentyone.world/' },
  { label: 'Einundzwanzig (DE)', to: 'https://einundzwanzig.space/' },
  { label: 'Mapa', to: 'https://mapa.berubitcoin.cz/' },
  { label: 'Mempool', to: 'https://mempool.jednadvacet.org' },
  { label: 'Explorer', to: 'https://explorer.jednadvacet.org' },
  { label: 'Grafika', to: 'https://github.com/Jednadvacetorg/jednadvacet-grafika' },
]
</script>

<template>
  <UFooter class="bg-default/75 backdrop-blur border-t border-gray-200 dark:border-gray-800 py-8 mt-16">
    <UContainer>
      <div class="flex flex-col items-center gap-10">
        <AppSocialMenu />

        <div class="flex flex-wrap justify-center gap-x-8 gap-y-4 text-sm text-gray-500 dark:text-gray-400">
          <NuxtLink
            v-for="link in footerLinks"
            :to="link.to"
            class="hover:text-primary transition-colors"
          >
            {{ link.label }}
          </NuxtLink>
          <NuxtLink
            :to="`/_studio?redirect=${encodeURIComponent($route.path)}`"
            external
            class="hover:text-primary transition-colors"
          >
            <UIcon name="i-lucide-user" />
        </NuxtLink>
        </div>
      </div>
    </UContainer>
  </UFooter>
</template>
