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
  { name: 'BTC Prague', caption: 'Podpoř Jednadvacet nákupem vstupenky', href: 'https://btcprg.me/JEDNADVACET', logo: '/images/partners/btc-prague.svg', logoDark: '/images/partners/btc-prague-dark.svg', logoSource: 'https://btcprague.com/', logoWidth: 126, logoHeight: 44 },
  { name: 'Účtovšem', caption: 'Hledáš účetní?', href: 'https://uctovsem.cz', logo: '/images/partners/uctovsem.png', logoDark: '/images/partners/uctovsem-dark.png', logoSource: 'https://www.uctovsem.cz/', logoWidth: 1940, logoHeight: 534 },
  { name: 'Firefish', caption: 'Vyzkoušej Firefish', href: 'http://firefish.io/?ref=jednadvacet', logo: '/images/partners/firefish.svg', logoDark: '/images/partners/firefish-dark.svg', logoSource: 'https://firefish.io/', logoWidth: 386, logoHeight: 86 },
  { name: 'Veribi', caption: 'Bitcoin těžba', href: 'https://app.veribi.com/signup?invite=9267', logo: '/images/partners/veribi.png', logoSource: 'https://veribi.com/', logoWidth: 1280, logoHeight: 640 },
  { name: '21energy', caption: 'Domácí těžba', href: 'https://21energy.com?sca_ref=8362575.HHRDEJ9MRFGkjM', logo: '/images/partners/21energy.svg', logoDark: '/images/partners/21energy-dark.svg', logoSource: 'https://21energy.com/', logoWidth: 160, logoHeight: 33 },
  { name: 'Stosuj', caption: 'DCA do bitcoinu', href: 'https://stosuj.cz/?aff=jednadvacet', logo: '/images/partners/stosuj.svg', logoDark: '/images/partners/stosuj-dark.svg', logoSource: 'https://stosuj.cz/', logoWidth: 1910, logoHeight: 512 },
  { name: 'FixedFloat', caption: 'Směnárna shitcoinů do bitcoinu', href: 'https://ff.io/?ref=8cw27hzb', logo: '/images/partners/fixedfloat.svg', logoDark: '/images/partners/fixedfloat-dark.svg', logoSource: 'https://ff.io/brand', logoWidth: 295, logoHeight: 60 },

  { name: 'Braiins', caption: 'Bitcoin mining', href: 'https://braiins.com/', logo: '/images/partners/braiins.svg', logoDark: '/images/partners/braiins-dark.svg', logoSource: 'https://braiins.com/', logoWidth: 864, logoHeight: 135.2984 },
  { name: 'Invity', caption: 'Nákup a správa bitcoinu', href: 'https://www.invity.io/', logo: '/images/partners/invity.svg', logoSource: 'https://www.invity.io/', logoWidth: 435, logoHeight: 124 },
  { name: 'Anycoin', caption: 'Česká kryptoměnová směnárna', href: 'https://www.anycoin.cz/', logo: '/images/partners/anycoin.svg', logoDark: '/images/partners/anycoin-dark.svg', logoSource: 'https://www.anycoin.cz/', logoWidth: 1116, logoHeight: 281 },
  { name: 'Coinmate', caption: 'Česká kryptoměnová burza', href: 'https://coinmate.io/cs/', logo: '/images/partners/coinmate.svg', logoDark: '/images/partners/coinmate-dark.svg', logoSource: 'https://coinmate.io/', logoWidth: 926, logoHeight: 529 },
  { name: 'ChainCamp', caption: 'Bitcoinová konference', href: 'https://www.chaincamp.cz/', logo: '/images/partners/chaincamp.svg', logoDark: '/images/partners/chaincamp-dark.svg', logoSource: 'https://www.chaincamp.cz/', logoWidth: 595, logoHeight: 154 },
  { name: 'CryptoByte', caption: 'Bitcoinová konference', href: 'https://cryptobyte.cz/', logo: '/images/partners/cryptobyte.svg', logoSource: 'https://cryptobyte.cz/', logoWidth: 283, logoHeight: 85 },
  { name: 'Bitcoin by Satoshi', caption: 'Bitcoinový merch', href: 'https://www.bitcoinbysatoshi.cz/', logo: '/images/partners/bitcoin-by-satoshi.jpg', logoSource: 'https://www.bitcoinbysatoshi.cz/', logoWidth: 2034, logoHeight: 1106 },
  { name: 'Kryptoplebs', caption: 'Bitcoinový podcast', href: 'https://www.youtube.com/@kryptoplebs', logo: '/images/partners/kryptoplebs.svg', logoSource: 'https://www.youtube.com/@kryptoplebs', logoWidth: 552, logoHeight: 84 },
  { name: 'Vexl', caption: 'Soukromá P2P směna bitcoinu', href: 'https://vexl.it/', logo: '/images/partners/vexl.svg', logoDark: '/images/partners/vexl-dark.svg', logoSource: 'https://vexl.it/', logoWidth: 181, logoHeight: 55 },
] as const satisfies readonly Partner[])

export const otherPartners = Object.freeze([
  { name: 'Dvadsaťjeden', caption: 'Slovenská bitcoinová komunita', href: 'https://www.dvadsatjeden.org/', logo: '/images/partners/dvadsatjeden.svg', logoDark: '/images/partners/dvadsatjeden-dark.svg', logoSource: 'https://www.dvadsatjeden.org/', logoWidth: 265, logoHeight: 36 },
  { name: 'Einundzwanzig', caption: 'Německá bitcoinová komunita', href: 'https://einundzwanzig.space/', logo: '/images/partners/einundzwanzig-horizontal.svg', logoDark: '/images/partners/einundzwanzig-horizontal-dark.svg', logoSource: 'https://einundzwanzig.space/media/', logoWidth: 134, logoHeight: 12 },
  { name: 'Twentyone World', caption: 'Síť komunit z celého světa', href: 'https://twentyone.world/', logo: '/images/partners/twentyone-world.svg', logoDark: '/images/partners/twentyone-world-dark.svg', logoSource: 'https://twentyone.world/logo/', logoWidth: 420, logoHeight: 69 },
  { name: 'BeruBitcoin.cz', caption: 'Pomáhá podnikům přijímat bitcoin', href: 'https://www.berubitcoin.cz/', logo: '/images/partners/berubitcoin.svg', logoDark: '/images/partners/berubitcoin-dark.svg', logoSource: 'https://www.berubitcoin.cz/', logoWidth: 2146, logoHeight: 299 },
  { name: 'BTCMap', caption: 'Mapa míst přijímajících bitcoin', href: 'https://btcmap.org/', logo: '/images/partners/btcmap.svg', logoSource: 'https://btcmap.org/', logoWidth: 267, logoHeight: 344 },
] as const satisfies readonly Partner[])
