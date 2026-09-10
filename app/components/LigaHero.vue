<template>
  <section class="relative isolate flex min-h-128 items-center justify-center overflow-hidden bg-black px-6 py-16 text-center sm:py-20">
    <NuxtImg
      src="/images/liga/pub-meetup.jpeg"
      alt=""
      width="2000"
      height="1500"
      sizes="sm:100vw md:100vw lg:100vw xl:100vw 2xl:100vw"
      preload
      class="absolute inset-0 z-0 size-full object-cover object-center opacity-70"
      aria-hidden="true"
    />
    <div class="absolute inset-0 z-10 bg-linear-to-b from-black/20 via-black/25 to-black/55" aria-hidden="true" />

    <div class="relative z-20 max-w-2xl">
      <img
        src="/images/liga/logo-foreground.svg"
        alt="Logo BTC Ligy"
        class="mx-auto w-56 sm:w-72"
      />
      <h1 class="sr-only">BTC Liga</h1>
      <p class="mt-5 text-base leading-7 text-inverted sm:text-lg">
        Celoroční vědomostní soutěž pro bitcoinové týmy z Česka a Slovenska.
      </p>
      <div class="mt-8 flex flex-wrap justify-center gap-3">
        <UButton to="mailto:liga@jednadvacet.org">Zaregistrovat tým</UButton>
        <UButton to="#moderatori" color="neutral" variant="outline">Chci pořádat kvíz</UButton>
      </div>
    </div>
  </section>
</template>
