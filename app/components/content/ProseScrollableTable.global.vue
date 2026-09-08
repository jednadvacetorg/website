<template>
  <div
    class="max-w-full overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
    role="group"
    aria-label="Tabulka s vodorovným posouváním"
    tabindex="0"
  >
    <table class="whitespace-nowrap">
      <slot />
    </table>
  </div>
</template>
