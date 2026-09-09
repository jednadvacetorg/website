<script setup lang="ts">
import type { NavigationMenuItem, NavigationMenuProps } from '@nuxt/ui'
import { navigationItems, supportNavigationItems } from '#shared/data/navigation'
import { useCommunityProjection, useDataBlogCategories } from '~/composables/content'

defineOptions({ inheritAttrs: false })

const { orientation = 'horizontal', ui } = defineProps<{
  orientation?: 'horizontal' | 'vertical'
  ui?: NavigationMenuProps['ui']
}>()

const attrs = useAttrs()
const { data: blogCategories } = await useDataBlogCategories()
const { projection: communities } = await useCommunityProjection()

const menuUi = computed(() => ({
  ...ui,
  ...(orientation === 'horizontal' ? { content: 'sm:w-auto' } : {}),
}))

const blogItems = computed<NavigationMenuItem[]>(() => [
  { label: 'Nejnovější články', to: '/blog' },
  ...(blogCategories.value?.map(category => ({
    label: category.title,
    to: category.path,
  })) ?? []),
])

const cityItems = computed<NavigationMenuItem[]>(() => [
  ...communities.value.prioritized.map(community => ({
    label: community.title,
    to: community.path,
  })),
  { label: 'Podle krajů', type: 'label' },
  ...communities.value.regions.map(group => ({
    label: group.region,
    children: group.communities.map(community => ({
      label: community.title,
      to: community.path,
    })),
  })),
])

const items = computed<NavigationMenuItem[]>(() => navigationItems.map((item) => {
  if (item.value === 'cities') {
    return orientation === 'horizontal'
      ? { ...item, slot: 'cities' as const }
      : { ...item, children: cityItems.value }
  }

  if (item.value === 'support') {
    return orientation === 'horizontal'
      ? { ...item, slot: 'support' as const }
      : {
          ...item,
          type: 'trigger' as const,
          children: [
            {
              label: 'Partneři',
              type: 'label' as const,
              slot: 'partner-logos',
              class: 'block px-0 py-2',
            },
            ...supportNavigationItems,
          ],
        }
  }

  if (item.value === 'blog') {
    return {
      ...item,
      children: blogItems.value,
      ...(orientation === 'vertical' ? { type: 'trigger' as const } : {}),
    }
  }

  if (item.value === 'projects' && orientation === 'horizontal') {
    return {
      ...item,
      ui: { content: 'sm:min-w-[25rem]' },
    }
  }

  return item
}))

const cityLinkClass = 'block rounded-md px-3 py-2 text-sm text-highlighted hover:bg-elevated focus-visible:outline-2 focus-visible:outline-primary'
</script>

<template>
  <UNavigationMenu
    v-bind="attrs"
    :items
    :orientation
    :ui="menuUi"
    aria-label="Hlavní navigace"
    content-orientation="vertical"
  >
    <template #cities-content>
      <div class="w-[32rem] max-w-[90vw] max-h-[calc(100vh-8rem)] overflow-y-auto p-5">
        <section>
          <ul class="grid grid-cols-3 gap-1">
            <li v-for="community in communities.prioritized" :key="community.path">
              <ULink :to="community.path" :class="cityLinkClass">
                {{ community.title }}
              </ULink>
            </li>
          </ul>
        </section>

        <div class="my-4 border-t border-default" />

        <div class="columns-2 gap-x-8">
          <section v-for="group in communities.regions" :key="group.region" class="mb-6 break-inside-avoid">
            <h2 class="mb-1 px-3 text-sm font-semibold text-muted">
              {{ group.region }}
            </h2>
            <ul>
              <li v-for="community in group.communities" :key="community.path">
                <ULink :to="community.path" :class="cityLinkClass">
                  {{ community.title }}
                </ULink>
              </li>
            </ul>
          </section>
        </div>
      </div>
    </template>

    <template #support-content>
      <div class="w-[min(90vw,32rem)] p-5">
        <PartnersList logo-only />
        <ul class="mt-3 grid grid-cols-2 gap-2 border-t border-default pt-3">
          <li v-for="child in supportNavigationItems" :key="child.to">
            <ULink :to="child.to" class="block rounded-md px-3 py-2 text-center text-sm font-medium text-highlighted hover:bg-elevated focus-visible:outline-2 focus-visible:outline-primary">
              {{ child.label }}
            </ULink>
          </li>
        </ul>
      </div>
    </template>

    <template #partner-logos>
      <PartnersList logo-only />
    </template>
  </UNavigationMenu>
</template>
