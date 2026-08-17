<script setup lang="ts">
import type { NavigationMenuItem } from '@nuxt/ui'

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
      { label: 'Trezor', description: 'HW peněženka', to: 'https://affil.trezor.io/aff_c?offer_id=137&aff_id=9775', target: '_blank' },
      { label: 'Stosuj', description: 'DCA do bitcoinu', to: 'https://stosuj.cz/?aff=jednadvacet', target: '_blank' },
      { label: '21Energy', description: 'Domácí těžba', to: 'https://21energy.com?sca_ref=8362575.HHRDEJ9MRFGkjM', target: '_blank' },
      { label: 'Veribi', description: 'Bitcoin těžba', to: 'https://app.veribi.com/signup?invite=9267', target: '_blank' },
      { label: 'FixedFloat', description: 'Směnárna do bitcoinu', to: 'https://ff.io/?ref=8cw27hzb', target: '_blank' },
      { label: 'Firefish', description: 'Půjčky na bitcoin', to: 'http://firefish.io/?ref=jednadvacet', target: '_blank' },
      { label: 'Účto všem', description: 'Hledáš účetní?', to: 'https://uctovsem.cz', target: '_blank' },
      { label: 'BTC Prague', description: 'Bitcoinová konference', to: 'https://btcprg.me/JEDNADVACET', target: '_blank' },
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
