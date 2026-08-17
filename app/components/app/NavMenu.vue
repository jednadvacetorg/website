<script setup lang="ts">
import type { NavigationMenuItem } from '@nuxt/ui'

const { data: blogCategories } = await useDataBlogCategories()
const { data: communities } = await useDataCommunities()

const REGION_CAPITALS: Record<string, string> = {
  'Středočeský kraj': '/praha',
  'Jihočeský kraj': '/ceske-budejovice',
  'Plzeňský kraj': '/plzen',
  'Karlovarský kraj': '/karlovy-vary',
  'Ústecký kraj': '/teplice',
  'Liberecký kraj': '/liberec',
  'Královéhradecký kraj': '/hradec-kralove',
  'Pardubický kraj': '/pardubice',
  'Kraj Vysočina': '/jihlava',
  'Jihomoravský kraj': '/brno',
  'Olomoucký kraj': '/olomouc',
  'Zlínský kraj': '/zlin',
  'Moravskoslezský kraj': '/ostrava',
}

const citiesByRegion = computed(() => {
  const all = communities.value ?? []
  const map = new Map<string, typeof all>()
  for (const c of all) {
    const region = c.region || 'Ostatní'
    if (!map.has(region)) map.set(region, [])
    map.get(region)!.push(c)
  }
  return [...map.entries()]
    .map(([region, cities]) => {
      const capital = REGION_CAPITALS[region]
      const sorted = capital
        ? [...cities].sort((a, b) => (a.path === capital ? -1 : b.path === capital ? 1 : 0))
        : cities
      return { region, cities: sorted }
    })
    .sort((a, b) => b.cities.length - a.cities.length)
})

const items = computed<NavigationMenuItem[]>(() => [
  {
    label: 'Města',
    slot: 'cities',
    ui: { content: 'w-max' },
  },
  {
    label: 'Kalendář',
    to: '/kalendar',
    children: [
      { label: 'Pro začátečníky' },
      { label: 'Pro rodiče s dětmi' },
      { label: 'Pokročilí' },
    ],
  },
  {
    label: 'Podpořit a partneři',
    to: '/podporit',
    children: [
      { label: 'TODO loga s afil linky' },
      { label: 'Další partneři', to: '/podporit#partneri' },
      { label: 'Přispět', to: '/podporit#prispet' },
    ],
  },
  {
    label: 'Blog',
    to: '/blog',
    children: [
      { label: 'Nejnovější články', to: '/blog' },
      ...(blogCategories.value?.map(category => ({
        label: category.title,
        to: category.path
      })) || [])
    ]
  },
  {
    label: 'O Jednadvacet',
    to: '/lide',
    children: [
      { label: 'Lidé', to: '/lide' },
      { label: 'Medojedíci', to: '/medojedici' },
      { label: 'Získej financování', to: '/finance' },
    ],
  },
])
</script>

<template>
  <UNavigationMenu :items="items" content-orientation="vertical">
    <template #cities-content>
      <div class="grid grid-cols-3 gap-x-8 gap-y-6 p-4 max-h-[70vh] overflow-y-auto">
        <div v-for="group in citiesByRegion" :key="group.region">
          <p class="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
            {{ group.region }}
          </p>
          <ul class="space-y-1">
            <li v-for="city in group.cities" :key="city.path">
              <NuxtLink
                :to="city.path"
                class="text-sm hover:text-primary transition-colors"
              >
                {{ city.title }}
              </NuxtLink>
            </li>
          </ul>
        </div>
      </div>
    </template>
  </UNavigationMenu>
</template>
