<script setup lang="ts">
import type { NavigationMenuItem } from '@nuxt/ui'
import { partners } from '~~/content/data/partners'

const { data: blogCategories } = await useDataBlogCategories()

const items = computed<NavigationMenuItem[]>(() => [
  {
    label: 'Města',
    to: '/#mapa',
    children: [
      { label: 'Brno' },
      { label: 'Praha' },
      { label: 'TODO' },
    ],
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
      ...partners.map(p => ({ label: p.name, description: p.caption, to: p.href, target: '_blank' as const })),
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
  <UNavigationMenu :items="items" content-orientation="vertical" />
</template>
