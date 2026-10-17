<template>
  <Head>
    <Link rel="icon" type="image/png" href="/icons/favicon-96x96.png" sizes="96x96" />
    <Link rel="icon" type="image/svg+xml" href="/icons/favicon.svg" />
    <Link rel="shortcut icon" href="/icons/favicon.ico" />
    <Link rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon.png" />
    <Meta name="apple-mobile-web-app-title" content="Jednadvacet" />
    <Link rel="manifest" href="/icons/site.webmanifest" />
  </Head>

  <UApp :locale="cs">
    <NuxtLayout>
      <NuxtRouteAnnouncer />
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>

<script setup lang="ts">
import { cs } from '@nuxt/ui/locale'

const route = useRoute()
const site = useSiteConfig()

useHead(() => ({
  htmlAttrs: {
    lang: 'cs',
  },
  titleTemplate: '%s | Jednadvacet',
  link: [
    { rel: 'canonical', href: new URL(route.path.replace(/\/$/, '') || '/', site.url).href },
  ],
}))
</script>
