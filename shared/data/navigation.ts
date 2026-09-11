import type { NavigationMenuItem } from '@nuxt/ui'

export const supportNavigationItems = [
  { label: 'Další partneři', to: '/podporit#dalsi-partneri' },
  { label: 'Přispět', to: '/podporit#prispet' },
] satisfies NavigationMenuItem[]

export const navigationItems: NavigationMenuItem[] = [
  {
    label: 'Města',
    value: 'cities',
  },
  {
    label: 'Kalendář',
    value: 'calendar',
    to: '/kalendar',
  },
  {
    label: 'Podpořit a partneři',
    value: 'support',
    to: '/podporit',
    children: supportNavigationItems,
  },
  {
    label: 'Blog',
    value: 'blog',
    to: '/blog',
  },
  {
    label: 'Projekty',
    value: 'projects',
    children: [
      {
        label: 'Monument',
        description: 'Postavme Satoshimu sochu v Praze.',
        icon: 'lucide:pyramid',
        to: 'https://satoshi.jednadvacet.org/',
        target: '_blank',
      },
      {
        label: 'Bitcoinová liga',
        description: 'Celoroční pubkvíz po celém Česku a Slovensku.',
        icon: 'lucide:trophy',
        to: '/liga',
      },
      {
        label: 'Bitcoin je mrtvý',
        description: 'Již 15 let sledujeme Bitcoin umírat',
        icon: 'streamline:christian-cross-2',
        to: 'https://mrtvy.jednadvacet.org',
        target: '_blank',
      },
      {
        label: 'BeruBitcoin.cz',
        description: 'Konzultace zdarma pro podnikatele kteří chtějí brát bitcoin.',
        icon: 'lucide:beer',
        to: 'https://www.berubitcoin.cz',
        target: '_blank',
      },
      {
        label: 'med-O-mat',
        description: 'Inovativní automat na med pro moderní včelaře',
        icon: 'pinhead:bee',
        to: 'https://www.med-o-mat.cz',
        target: '_blank',
      },
      {
        label: 'Payky',
        description: 'Jednoduchá a soukromá pokladní aplikace pro obchodníky',
        icon: 'streamline:shopping-cart-1-remix',
        to: 'https://payky.me/',
        target: '_blank',
      },
      {
        label: 'Linky',
        description: 'Jednoduchá a soukromá mobilní peněženka s chatem',
        icon: 'streamline:chat-bubble-typing-oval-remix',
        to: 'https://linky.fit',
        target: '_blank',
      },
      {
        label: 'Získej financování',
        description: 'Pomůžeme tu najít sponzory tvého projektu.',
        to: '/finance',
      },
      {
        label: 'Lidé',
        description: 'Komunita, která stojí za Jednadvacet.',
        to: '/lide',
      },
    ],
  },
]
