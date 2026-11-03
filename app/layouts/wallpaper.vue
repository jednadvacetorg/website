<template>
  <Head>
    <Body class="bg-cover bg-fixed bg-center bg-primary-800" :style="{ 'background-image': `url(${bgSrc})` }" />
  </Head>

  <AppNavBar />
  <UContainer class="min-h-[calc(100vh-2*var(--ui-header-height))] flex items-center justify-center text-center py-10">
    <slot />
  </UContainer>
  <AppFooter />
</template>

<script setup lang="ts">
defineProps<{
  bgSrc: string
}>()
</script>
