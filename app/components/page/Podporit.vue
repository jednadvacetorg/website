<script setup lang="ts">
import QRCode from 'qrcode'

type FinanceData = {
  balance: number
  unused_address: string
  ln_address: string
}

type WorkersData = Record<string, {
  hash_rate_24h_GH: number
  state: string
  last_share: number
}>

// Data se stahují až v prohlížeči (server: false) — stránka je prerendrovaná
// a zdrojové JSONy zatím generuje cron na starém WordPressu.
const { data: finance } = useFetch<FinanceData>('/api/finance', { server: false, lazy: true })
const { data: workers } = useFetch<WorkersData>('/api/miners', { server: false, lazy: true })

const donateMode = ref<'lightning' | 'onchain'>('lightning')

const donateAddress = computed(() => {
  if (donateMode.value === 'onchain') return finance.value?.unused_address ?? null
  return finance.value?.ln_address ?? 'donate@jednadvacet.org'
})

const donateUri = computed(() => {
  if (!donateAddress.value) return null
  return donateMode.value === 'onchain'
    ? `bitcoin:${donateAddress.value}`
    : `lightning:${donateAddress.value}`
})

const qrCodeDataUrl = ref<string | null>(null)

watchEffect(async () => {
  if (!donateUri.value) {
    qrCodeDataUrl.value = null
    return
  }
  qrCodeDataUrl.value = await QRCode.toDataURL(donateUri.value, {
    margin: 1,
    width: 256,
  })
})

function copy(text: string | null) {
  if (text) navigator.clipboard.writeText(text)
}

const poolConfig = [
  { label: 'Pool URL', value: 'stratum+tcp://eu.stratum.braiins.com:3333' },
  { label: 'Username', value: 'jednadvacet.tvoje_prezdivka' },
  { label: 'Heslo', value: 'anything123' },
]

const showAllWorkers = ref(false)

const sortedWorkers = computed(() => {
  if (!workers.value) return []
  return Object.entries(workers.value)
    .map(([name, info]) => ({ name, ...info }))
    .sort((a, b) => b.hash_rate_24h_GH - a.hash_rate_24h_GH)
})

const visibleWorkers = computed(() => {
  return showAllWorkers.value ? sortedWorkers.value : sortedWorkers.value.slice(0, 3)
})

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
  { name: 'Mempool', url: 'https://mempool.jednadvacet.org' },
  { name: 'Whitepaper', url: 'https://bitcoin.org/bitcoin.pdf' },
]
</script>

<template>
  <UContainer class="py-16 space-y-20">
    <!-- Přispět -->
    <section id="prispet">
      <h2 class="text-3xl font-bold mb-3">Přispět Jednadvacítce</h2>
      <p class="text-gray-400 max-w-xl mb-8">
        Největší podporu dáte komunitě tak, že nám napíšete a přiložíte jakkoliv ruku k&nbsp;dílu.
        Pokud chcete přispět finančně, uvítáme platbu onchain i&nbsp;přes Lightning Network.
        Příspěvky se snažíme použít nejlépe, jak to jde.
      </p>

      <div class="flex flex-col sm:flex-row gap-8 items-center justify-center">
        <div class="rounded-xl border border-gray-800 bg-gray-950 p-5 space-y-4 w-full sm:w-[28rem] shrink-0">
          <div class="flex items-center gap-2 text-sm text-gray-400">
            <UIcon name="i-lucide-piggy-bank" class="w-4 h-4 text-primary shrink-0" />
            <span>Aktuální zůstatek:</span>
            <span class="font-mono text-white">
              {{ finance ? finance.balance.toLocaleString('cs-CZ') : '…' }}
            </span>
            <span>sats</span>
          </div>

          <UTabs
            v-model="donateMode"
            :items="[
              { label: 'Lightning', value: 'lightning', icon: 'i-lucide-zap' },
              { label: 'Onchain', value: 'onchain', icon: 'i-lucide-link' },
            ]"
            size="sm"
          />

          <div class="flex items-center gap-3">
            <span class="font-mono text-sm select-all break-all">
              {{ donateAddress ?? 'Načítání…' }}
            </span>
            <UButton size="xs" variant="ghost" icon="i-lucide-copy" :disabled="!donateAddress" @click="copy(donateAddress)" />
          </div>

          <UButton v-if="donateUri" :to="donateUri" size="md" color="primary" icon="i-lucide-wallet">
            Zaplatit v peněžence
          </UButton>
        </div>

        <div class="rounded-lg border border-gray-800 p-3 bg-white shrink-0">
          <img v-if="qrCodeDataUrl" :src="qrCodeDataUrl" alt="QR kód pro příspěvek" class="h-40 w-40" />
          <div v-else class="h-40 w-40 flex items-center justify-center text-sm text-gray-400">
            QR se připravuje…
          </div>
        </div>
      </div>
    </section>

    <!-- Získej financování -->
    <section id="financovani">
      <h2 class="text-3xl font-bold mb-3">Získej peníze na svůj projekt</h2>
      <p class="text-gray-400 max-w-xl mb-4">
        Pokud chceš tvořit obsah, propagovat Jednadvacítku, případně dělat cokoliv,
        co pomáhá bitcoinu v&nbsp;Česku, neboj se nás zeptat na příspěvek na tvoji činnost.
      </p>
      <p class="text-gray-400 max-w-xl">
        Napiš nám, jak bys chtěl Jednadvacítce pomoci a co pro tebe můžeme udělat, na
        <a href="mailto:info@jednadvacet.org" class="text-primary hover:underline">info@jednadvacet.org</a>.
      </p>
    </section>

    <!-- Těžba -->
    <section id="tezba">
      <h2 class="text-3xl font-bold mb-3">Přispěj těžbou</h2>
      <p class="text-gray-400 max-w-xl mb-8">
        Pokud těžíš bitcoin, můžeš přesměrovat část svého výkonu na BraiinsPool a tím nás podpořit.
        Pool nás vyplácí jednou denně, příspěvky chodí do naší lightning peněženky
        a propisují se do zůstatku výše. Detailní návod najdeš
        <a
          href="https://x.com/_Honza_Dvorak/status/1891751852443660663"
          target="_blank"
          rel="noopener noreferrer"
          class="text-primary hover:underline"
        >zde</a>.
      </p>

      <div class="grid lg:grid-cols-2 gap-6 items-start">
        <div class="rounded-xl border border-gray-800 bg-gray-950 overflow-hidden">
          <h3 class="font-semibold flex items-center gap-2 px-5 py-4 border-b border-gray-800 bg-gray-900/60">
            <UIcon name="i-lucide-settings-2" class="w-4 h-4 text-primary shrink-0" />
            Nastavení pro BraiinsPool
          </h3>
          <dl class="divide-y divide-gray-800/70">
            <div
              v-for="row in poolConfig"
              :key="row.label"
              class="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4 px-5 py-3"
            >
              <dt class="text-xs uppercase tracking-wider text-gray-500 sm:w-24 shrink-0">{{ row.label }}</dt>
              <dd class="flex items-center gap-2 min-w-0">
                <code class="font-mono text-sm text-gray-100 bg-gray-900 border border-gray-800 rounded-md px-2 py-1 select-all break-all">
                  {{ row.value }}
                </code>
                <UButton size="xs" variant="ghost" icon="i-lucide-copy" @click="copy(row.value)" />
              </dd>
            </div>
          </dl>
        </div>

        <div class="rounded-xl border border-gray-800 bg-gray-950 overflow-hidden">
          <h3 class="font-semibold flex items-center gap-2 px-5 py-4 border-b border-gray-800 bg-gray-900/60">
            <UIcon name="i-lucide-pickaxe" class="w-4 h-4 text-primary shrink-0" />
            Těží bitcoin pro 21
          </h3>
          <div class="px-5 py-3">
            <table class="w-full text-sm">
              <thead>
                <tr class="text-left text-gray-400">
                  <th class="pb-2 font-normal">Jméno</th>
                  <th class="pb-2 font-normal">Hashrate</th>
                  <th class="pb-2 font-normal">Stav</th>
                </tr>
              </thead>
              <tbody>
                <tr v-if="!sortedWorkers.length">
                  <td colspan="3" class="py-1 text-gray-400">Načítání…</td>
                </tr>
                <tr v-for="w in visibleWorkers" :key="w.name" class="border-t border-gray-800">
                  <td class="py-1.5">{{ w.name }}</td>
                  <td class="py-1.5 font-mono">{{ w.hash_rate_24h_GH.toFixed(2) }} GH/s</td>
                  <td class="py-1.5">
                    <UBadge :color="w.state === 'ok' ? 'success' : 'warning'" variant="subtle" size="sm">
                      {{ w.state }}
                    </UBadge>
                  </td>
                </tr>
              </tbody>
            </table>
            <UButton
              v-if="sortedWorkers.length > 3"
              size="xs"
              variant="ghost"
              class="mt-3"
              @click="showAllWorkers = !showAllWorkers"
            >
              {{ showAllWorkers ? '− Skrýt' : '+ Zobrazit více' }}
            </UButton>
          </div>
        </div>
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
