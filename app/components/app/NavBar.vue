<template>
  <UHeader>
    <template #left>
      <NuxtLink to="/">
        <AppLogo />
      </NuxtLink>
    </template>

    <AppNavMenu class="max-lg:hidden" />

    <template #right>
      <AppSocialMenu class="max-lg:hidden" />
      <USeparator orientation="vertical" class="h-5 max-lg:hidden" />
      <UColorModeButton />
    </template>

    <template #body>
      <AppNavMenu orientation="vertical" :ui="{ link: 'py-3 text-xl justify-center' }" />
      <AppSocialMenu class="justify-center mt-14" />
    </template>
  </UHeader>
</template>
