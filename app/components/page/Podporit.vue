<script setup lang="ts">
const affiliates = [
  {
    name: 'Trezor',
    description: 'HW peněženka',
    url: 'https://affil.trezor.io/aff_c?offer_id=137&aff_id=9775',
    logo: '/logos/trezor.svg',
  },
  {
    name: 'Stosuj',
    description: 'DCA do bitcoinu',
    url: 'https://stosuj.cz/?aff=jednadvacet',
    logo: '/logos/stosuj.png',
  },
  {
    name: '21Energy',
    description: 'Domácí těžba',
    url: 'https://21energy.com?sca_ref=8362575.HHRDEJ9MRFGkjM',
    logo: '/logos/21energy.webp',
  },
  {
    name: 'Veribi',
    description: 'Bitcoin těžba',
    url: 'https://app.veribi.com/signup?invite=9267',
    logo: '/logos/veribi.png',
  },
  {
    name: 'FixedFloat',
    description: 'Směnárna do bitcoinu',
    url: 'https://ff.io/?ref=8cw27hzb',
    logo: '/logos/fixedfloat.png',
  },
  {
    name: 'Firefish',
    description: 'Půjčky na bitcoin',
    url: 'http://firefish.io/?ref=jednadvacet',
    logo: '/logos/firefish.png',
  },
  {
    name: 'Účto všem',
    description: 'Hledáš účetní?',
    url: 'https://uctovsem.cz',
    logo: '/logos/uctovsem.png',
  },
  {
    name: 'BTC Prague',
    description: 'Bitcoinová konference',
    url: 'https://btcprg.me/JEDNADVACET',
    logo: '/logos/btcprague.svg',
  },
]

const partners = [
  { name: 'Dvadsaťjeden (SK)', url: 'https://dvadsatjeden.sk' },
  { name: 'Twentyone World (EN)', url: 'https://twentyone.world' },
  { name: 'Einundzwanzig (DE)', url: 'https://einundzwanzig.space' },
  { name: 'BtcMap', url: 'https://btcmap.org' },
  { name: 'Mempool', url: 'https://mempool.space' },
  { name: 'Whitepaper', url: 'https://bitcoin.org/bitcoin.pdf' },
]

function copyLightning() {
  navigator.clipboard.writeText('donate@jednadvacet.org')
}
</script>

<template>
  <UContainer class="py-16 space-y-20">
    <!-- Přispět -->
    <section id="prispet">
      <h2 class="text-3xl font-bold mb-3">Přispět Jednadvacítce</h2>
      <p class="text-gray-400 max-w-xl mb-8">
        Největší podporu dáte komunitě tak, že nám napíšete a přiložíte jakkoliv ruku k&nbsp;dílu.
        Pokud chcete přispět finančně, uvítáme platbu přes Lightning Network.
      </p>
      <div class="flex flex-wrap items-center gap-3">
        <div class="inline-flex items-center gap-3 rounded-xl border border-gray-800 bg-gray-950 px-5 py-4">
          <UIcon name="i-lucide-zap" class="w-5 h-5 text-primary shrink-0" />
          <span class="font-mono text-sm select-all">donate@jednadvacet.org</span>
          <UButton size="xs" variant="ghost" icon="i-lucide-copy" @click="copyLightning" />
        </div>
        <UButton to="lightning:donate@jednadvacet.org" size="md" color="primary" icon="i-lucide-wallet">
          Zaplatit v peněžence
        </UButton>
      </div>
    </section>

    <!-- Affiliate -->
    <section id="affiliate">
      <h2 class="text-3xl font-bold mb-3">Affiliate odkazy</h2>
      <p class="text-gray-400 max-w-xl mb-8">
        Nákupem přes tyto odkazy podpoříš Jednadvacet — část provize putuje zpátky do komunity.
      </p>
      <div class="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <a
          v-for="a in affiliates"
          :key="a.name"
          :href="a.url"
          target="_blank"
          rel="noopener noreferrer"
          class="group flex flex-col gap-3 rounded-xl border border-gray-800 hover:border-primary/50 bg-gray-950/50 hover:bg-gray-900 transition-colors p-5"
        >
          <img :src="a.logo" :alt="a.name" class="h-8 w-auto object-contain" />
          <div>
            <p class="font-semibold group-hover:text-primary transition-colors">{{ a.name }}</p>
            <p class="text-sm text-gray-400">{{ a.description }}</p>
          </div>
        </a>
      </div>
    </section>

    <!-- Další partneři -->
    <section id="partneri">
      <h2 class="text-3xl font-bold mb-3">Další partneři</h2>
      <p class="text-gray-400 max-w-xl mb-8">
        Projekty a organizace, se kterými spolupracujeme.
      </p>
      <div class="flex flex-wrap gap-3">
        <a
          v-for="p in partners"
          :key="p.name"
          :href="p.url"
          target="_blank"
          rel="noopener noreferrer"
          class="rounded-full border border-gray-800 hover:border-primary/50 hover:text-primary px-4 py-2 text-sm transition-colors"
        >
          {{ p.name }}
        </a>
      </div>
    </section>
  </UContainer>
</template>
