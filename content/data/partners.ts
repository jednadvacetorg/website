export interface Partner {
  name: string
  caption: string
  href: string
  logo: string
  logoSource: string
  logoWidth: number
  logoHeight: number
  /** Varianta loga pro tmavý režim; bez ní se používá `logo` v obou režimech. */
  logoDark?: string
}

export const partners: readonly Partner[] = Object.freeze([
  { name: 'Účtovšem', caption: 'Hledáš účetní?', href: 'https://uctovsem.cz', logo: '/images/partners/uctovsem.png', logoSource: 'https://www.uctovsem.cz/wp-content/uploads/2022/05/UV-LOGO.png', logoWidth: 1940, logoHeight: 534, logoDark: '/images/partners/uctovsem-dark.png' },
  { name: 'Firefish', caption: 'Vyzkoušej Firefish', href: 'http://firefish.io/?ref=jednadvacet', logo: '/images/partners/firefish.jpg', logoSource: 'https://firefish.io/', logoWidth: 1024, logoHeight: 342 },
  { name: 'Trezor', caption: 'Trezor HW Peněženka', href: 'https://affil.trezor.io/aff_c?offer_id=137&aff_id=9775', logo: '/images/partners/trezor.svg', logoSource: 'https://trezor.io/', logoWidth: 1482, logoHeight: 378, logoDark: '/images/partners/trezor-dark.svg' },
  { name: 'Veribi', caption: 'Bitcoin těžba', href: 'https://app.veribi.com/signup?invite=9267', logo: '/images/partners/veribi.png', logoSource: 'https://veribi.com/wp-content/uploads/2024/02/VERIBI-Logo-on-Blue.png', logoWidth: 1280, logoHeight: 640 },
  { name: 'Stosuj', caption: 'DCA do bitcoinu', href: 'https://stosuj.cz/?aff=jednadvacet', logo: '/images/partners/stosuj.svg', logoSource: 'https://stosuj.cz/', logoWidth: 1910, logoHeight: 512, logoDark: '/images/partners/stosuj-dark.svg' },
  { name: '21energy', caption: 'Domácí těžba', href: 'https://21energy.com?sca_ref=8362575.HHRDEJ9MRFGkjM', logo: '/images/partners/21energy.svg', logoSource: 'https://21energy.com/', logoWidth: 160, logoHeight: 33, logoDark: '/images/partners/21energy-dark.svg' },
  { name: 'FixedFloat', caption: 'Směnárna shitcoinů do bitcoinu', href: 'https://ff.io/?ref=8cw27hzb', logo: '/images/partners/fixedfloat.svg', logoSource: 'https://ff.io/brand', logoWidth: 295, logoHeight: 128, logoDark: '/images/partners/fixedfloat-dark.svg' },
  { name: 'BTC Prague', caption: 'Podpoř Jednadvacet nákupem vstupenky', href: 'https://btcprg.me/JEDNADVACET', logo: '/images/partners/btc-prague.svg', logoSource: 'https://btcprague.com/wp-content/themes/fns_template/assets/img/btc-prague-logo-positive-orange.svg', logoWidth: 126, logoHeight: 44, logoDark: '/images/partners/btc-prague-dark.svg' },
])
