<script setup lang="ts">
const iconCandidates = {
  myths: [
    'i-lucide-shield-question',
    'i-lucide-scan-search',
    'i-lucide-badge-check',
    'i-lucide-message-square-warning',
    'i-pinhead-exclamation-point-beside-question-mark',
    'i-streamline-affordable-and-clean-energy',
    'i-lucide-leaf',
    'i-lucide-factory',
    'i-bitcoin-icons-lightning-circle-outline',
  ],
  gettingStarted: [
    'i-simple-icons-trezor',
    'i-lucide-footprints',
    'i-lucide-signpost',
    'i-lucide-key-round',
    'i-lucide-sprout',
    'i-streamline-arrow-roadmap',
    'i-pinhead-guidepost',
  ],
  stories: [
    'i-lucide-message-circle-heart',
    'i-lucide-book-heart',
  ],
  money: [
    'i-lucide-scale',
    'i-simple-icons-bitcoin',
    'i-lucide-hand-coins',
    'i-lucide-piggy-bank',
    'i-lucide-lock-keyhole-open',
    'i-lucide-bird',
    'i-pinhead-banknote-in-hand',
    'i-pinhead-dove',
    'i-streamline-coin-share',
  ],
  community: [
    'i-lucide-map-pinned',
    'i-lucide-calendar-days',
    'i-streamline-group-meeting-call',
    'i-pinhead-campfire',
    'i-pinhead-campfire-in-arch',
    'i-pinhead-crowd-of-people',
    'i-pinhead-people-sitting-in-theater',
    'i-lucide-flame-kindling',
    'i-lucide-users-round',
  ],
} as const
</script>

<template>
  <UPageSection
    title="Co tě zajímá?"
    description="Vyber si téma a začni tím, co právě řešíš."
  >
    <template #features>
      <UPageFeature as="li" title="Bourání mýtů" orientation="vertical">
        <template #leading>
          <div class="flex flex-wrap gap-3">
            <UIcon
              v-for="icon in iconCandidates.myths"
              :key="icon"
              :name="icon"
              :aria-label="icon"
              :title="icon"
              role="img"
              class="size-6 text-primary"
            />
          </div>
        </template>
        <template #description>
          <p>
            Obvyklé dezinformace a polopravdy o podvodech, kryptoměnách, spotřebě energie, ekologii nebo kriminalitě.
          </p>
        </template>
      </UPageFeature>

      <UPageFeature as="li" title="Jak začít" orientation="vertical">
        <template #leading>
          <div class="flex flex-wrap gap-3">
            <UIcon
              v-for="icon in iconCandidates.gettingStarted"
              :key="icon"
              :name="icon"
              :aria-label="icon"
              :title="icon"
              role="img"
              class="size-6 text-primary"
            />
          </div>
        </template>
        <template #description>
          <p>
            Jak získat první satoshi, vybrat peněženku a pravidelně spořit bez zbytečného žargonu. Pokračuj návodem na
            <ULink to="/blog/bitcoin-pod-vlastni-kontrolou" class="font-medium text-highlighted underline decoration-primary underline-offset-2">vlastní peněženku</ULink>, vysvětlením
            nebo přehledem <ULink to="/blog/studuj-bitcoin" class="font-medium text-highlighted underline decoration-primary underline-offset-2">nástrojů pro nákup a spoření</ULink>.
          </p>
        </template>
      </UPageFeature>

      <UPageFeature as="li" title="Příběhy lidí" orientation="vertical">
        <template #leading>
          <div class="flex flex-wrap gap-3">
            <UIcon
              v-for="icon in iconCandidates.stories"
              :key="icon"
              :name="icon"
              :aria-label="icon"
              :title="icon"
              role="img"
              class="size-6 text-primary"
            />
          </div>
        </template>
        <template #description>
          <p>
            Poznej zkušenosti partnerů, rodin, mladých lidí i organizátorů českých bitcoinových komunit. Jejich
            <ULink to="#pribehy" class="font-medium text-highlighted underline decoration-primary underline-offset-2">osobní příběhy</ULink>
            ukazují, jak Bitcoin pomáhá při spoření, změně práce i hledání lidí, kteří si navzájem poradí.
          </p>
        </template>
      </UPageFeature>

      <UPageFeature as="li" title="Peníze a svoboda" orientation="vertical">
        <template #leading>
          <div class="flex flex-wrap gap-3">
            <UIcon
              v-for="icon in iconCandidates.money"
              :key="icon"
              :name="icon"
              :aria-label="icon"
              :title="icon"
              role="img"
              class="size-6 text-primary"
            />
          </div>
        </template>
        <template #description>
          <p>
            Pochop, jak <ULink to="/blog/vas-majetek-se-pomalu-vytraci" class="font-medium text-highlighted underline decoration-primary underline-offset-2">inflace mění hodnotu úspor</ULink>
            a proč záleží na tom, kdo má peníze pod kontrolou. Prozkoumej také
            <ULink to="/blog/je-na-case-platit-bitcoinem" class="font-medium text-highlighted underline decoration-primary underline-offset-2">přímé platby bez prostředníka</ULink>
            nebo <ULink to="/blog/ucebnice-bitcoinovy-diplom" class="font-medium text-highlighted underline decoration-primary underline-offset-2">finanční vzdělávání dětí</ULink>.
          </p>
        </template>
      </UPageFeature>

      <UPageFeature as="li" title="Komunita a akce" orientation="vertical">
        <template #leading>
          <div class="flex flex-wrap gap-3">
            <UIcon
              v-for="icon in iconCandidates.community"
              :key="icon"
              :name="icon"
              :aria-label="icon"
              :title="icon"
              role="img"
              class="size-6 text-primary"
            />
          </div>
        </template>
        <template #description>
          <p>
            Najdi <ULink to="/kalendar" class="font-medium text-highlighted underline decoration-primary underline-offset-2">sraz nebo přednášku ve svém okolí</ULink>
            a podívej se, jak podobná setkání vypadají třeba <ULink to="/blog/jednadvacet-na-chaincampu" class="font-medium text-highlighted underline decoration-primary underline-offset-2">na Chaincampu</ULink>.
            Pomoci můžeš také tím, že naťukneš svůj oblíbený podnik, aby bral bitcoin.
          </p>
        </template>
      </UPageFeature>
    </template>
  </UPageSection>
</template>
