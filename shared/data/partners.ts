export interface Partner {
  name: string
  caption: string
  href: string
  logo: string
  logoSource: string
  logoWidth: number
  logoHeight: number
  logoDark?: string
}

export const partners = Object.freeze([
  { name: 'Trezor', caption: 'Trezor HW Peněženka', href: 'https://affil.trezor.io/aff_c?offer_id=137&aff_id=9775', logo: '/images/partners/trezor.svg', logoDark: '/images/partners/trezor-dark.svg', logoSource: 'https://trezor.io/', logoWidth: 1482, logoHeight: 378 },
  { name: 'BTC Prague', caption: 'Podpoř Jednadvacet nákupem vstupenky', href: 'https://btcprg.me/JEDNADVACET', logo: '/images/partners/btc-prague.svg', logoDark: '/images/partners/btc-prague-dark.svg', logoSource: 'https://btcprague.com/wp-content/themes/fns_template/assets/img/btc-prague-logo-positive-orange.svg', logoWidth: 126, logoHeight: 44 },
  { name: 'Účtovšem', caption: 'Hledáš účetní?', href: 'https://uctovsem.cz', logo: '/images/partners/uctovsem.png', logoDark: '/images/partners/uctovsem-dark.png', logoSource: 'https://www.uctovsem.cz/wp-content/uploads/2022/05/UV-LOGO.png', logoWidth: 1940, logoHeight: 534 },
  { name: 'Firefish', caption: 'Vyzkoušej Firefish', href: 'http://firefish.io/?ref=jednadvacet', logo: '/images/partners/firefish.jpg', logoSource: 'https://firefish.io/', logoWidth: 1024, logoHeight: 342 },
  { name: 'Veribi', caption: 'Bitcoin těžba', href: 'https://app.veribi.com/signup?invite=9267', logo: '/images/partners/veribi.png', logoSource: 'https://veribi.com/wp-content/uploads/2024/02/VERIBI-Logo-on-Blue.png', logoWidth: 1280, logoHeight: 640 },
  { name: '21energy', caption: 'Domácí těžba', href: 'https://21energy.com?sca_ref=8362575.HHRDEJ9MRFGkjM', logo: '/images/partners/21energy.svg', logoDark: '/images/partners/21energy-dark.svg', logoSource: 'https://21energy.com/', logoWidth: 160, logoHeight: 33 },
  { name: 'Stosuj', caption: 'DCA do bitcoinu', href: 'https://stosuj.cz/?aff=jednadvacet', logo: '/images/partners/stosuj.svg', logoDark: '/images/partners/stosuj-dark.svg', logoSource: 'https://stosuj.cz/', logoWidth: 1910, logoHeight: 512 },
  { name: 'FixedFloat', caption: 'Směnárna shitcoinů do bitcoinu', href: 'https://ff.io/?ref=8cw27hzb', logo: '/images/partners/fixedfloat.svg', logoDark: '/images/partners/fixedfloat-dark.svg', logoSource: 'https://ff.io/brand', logoWidth: 295, logoHeight: 128 },
] as const satisfies readonly Partner[])

export const otherPartners = Object.freeze([
  { name: 'Dvadsaťjeden', caption: 'Slovenská bitcoinová komunita', href: 'https://www.dvadsatjeden.org/', logo: '/images/partners/dvadsatjeden.svg', logoDark: '/images/partners/dvadsatjeden-dark.svg', logoSource: 'https://www.dvadsatjeden.org/wp-content/uploads/2023/09/Logo-Mensie.svg', logoWidth: 265, logoHeight: 36 },
  { name: 'Einundzwanzig', caption: 'Německá bitcoinová komunita', href: 'https://einundzwanzig.space/', logo: '/images/partners/einundzwanzig-horizontal.svg', logoDark: '/images/partners/einundzwanzig-horizontal-dark.svg', logoSource: 'https://einundzwanzig.space/media/', logoWidth: 134, logoHeight: 12 },
  { name: 'Twentyone World', caption: 'Síť komunit z celého světa', href: 'https://twentyone.world/', logo: '/images/partners/twentyone-world.svg', logoDark: '/images/partners/twentyone-world-dark.svg', logoSource: 'https://twentyone.world/logo/', logoWidth: 420, logoHeight: 69 },
  { name: 'Vexl', caption: 'Soukromá P2P směna bitcoinu', href: 'https://vexl.it/', logo: '/images/partners/vexl.svg', logoDark: '/images/partners/vexl-dark.svg', logoSource: 'https://vex-it-website-v2.vercel.app/brand/logos/main-logo', logoWidth: 181, logoHeight: 55 },
  { name: 'BeruBitcoin.cz', caption: 'Pomáhá podnikům přijímat bitcoin', href: 'https://www.berubitcoin.cz/', logo: '/images/partners/berubitcoin.svg', logoDark: '/images/partners/berubitcoin-dark.svg', logoSource: 'https://www.berubitcoin.cz/assets/619130248fa52fb9e386d51c_Logo%20BeruBitcoin%20white.svg', logoWidth: 2146, logoHeight: 299 },
  { name: 'BTCMap', caption: 'Mapa míst přijímajících bitcoin', href: 'https://btcmap.org/', logo: '/images/partners/btcmap.svg', logoSource: 'https://btcmap.org/images/logo.svg', logoWidth: 267, logoHeight: 344 },
] as const satisfies readonly Partner[])
