export type OgImageFormat = 'landscape' | 'square' | 'portrait' | 'youtube'
export type OgImageLayout = 'default' | 'host'

export interface OgImageTypicalPreview {
  /** Width in px at which the platform typically displays the image. */
  width: number
  /** Height in px at which the platform typically displays the image. */
  height: number
  /** Where this display size occurs. */
  label: string
}

export interface OgImageVariant {
  key: string
  label: string
  description: string
  width: number
  height: number
  format: OgImageFormat
  /** Render scale multiplier (used for the 4K export of the same layout). */
  scale?: number
  /** Variants published in the article's public meta tags. The rest are debug/download only. */
  isPublic: boolean
  /** Typical on-platform display size. Omitted where a small preview has no justification. */
  typicalPreview?: OgImageTypicalPreview
}

export const ogImageVariants: OgImageVariant[] = [
  { key: 'og', label: 'OG Landscape', description: 'Facebook, obecné sdílení odkazů', width: 1200, height: 630, format: 'landscape', isPublic: true, typicalPreview: { width: 500, height: 261, label: 'Facebook – odkaz ve feedu' } },
  { key: 'twitter', label: 'X Card', description: 'Twitter/X karta, poměr 2 : 1', width: 1200, height: 600, format: 'landscape', isPublic: true, typicalPreview: { width: 360, height: 180, label: 'X – karta v timeline' } },
  { key: 'square', label: 'Square Preview', description: 'Doplňkový čtvercový OG obrázek, zejména WhatsApp', width: 800, height: 800, format: 'square', isPublic: true, typicalPreview: { width: 160, height: 160, label: 'WhatsApp – náhled odkazu' } },
  { key: 'linkedin', label: 'LinkedIn', description: 'Sdílení na LinkedIn', width: 1200, height: 627, format: 'landscape', isPublic: false, typicalPreview: { width: 360, height: 188, label: 'LinkedIn – náhled odkazu' } },
  { key: 'social-square', label: 'Social Square', description: 'Instagram/Facebook příspěvek, čtvercový podcastový obal', width: 1080, height: 1080, format: 'square', isPublic: false, typicalPreview: { width: 320, height: 320, label: 'Instagram – příspěvek ve feedu' } },
  { key: 'social-portrait', label: 'Social Portrait', description: 'Příspěvky na výšku, poměr 4 : 5', width: 1080, height: 1350, format: 'portrait', isPublic: false, typicalPreview: { width: 300, height: 375, label: 'Instagram – příspěvek na výšku' } },
  { key: 'social-vertical', label: 'Social Vertical', description: 'Stories, Reels, TikTok a Shorts', width: 1080, height: 1920, format: 'portrait', isPublic: false, typicalPreview: { width: 180, height: 320, label: 'Stories – náhled' } },
  { key: 'youtube', label: 'YouTube', description: 'Běžná video náhledovka', width: 1920, height: 1080, format: 'youtube', isPublic: false, typicalPreview: { width: 360, height: 202, label: 'YouTube – výsledky vyhledávání' } },
  { key: 'youtube-4k', label: 'YouTube 4K', description: 'Volitelný export ve vyšším rozlišení', width: 3840, height: 2160, format: 'youtube', scale: 2, isPublic: false },
]

export interface OgImageSource {
  title: string
  image: string
  layout?: OgImageLayout
}

export interface OgImageCall {
  /** Props shared by all variants of one image. */
  sharedProps: Record<string, unknown>
  /** Per-variant size options for `defineOgImage`. Same order as `ogImageVariants`. */
  allOptions: Record<string, unknown>[]
  /** Per-variant size options for the public article meta tags only. */
  publicOptions: Record<string, unknown>[]
}

function variantOptions(variant: OgImageVariant): Record<string, unknown> {
  return {
    key: variant.key,
    width: variant.width,
    height: variant.height,
    props: { format: variant.format, scale: variant.scale ?? 1 },
  }
}

export function buildOgImageCall(source: OgImageSource): OgImageCall {
  return {
    sharedProps: {
      title: source.title,
      image: source.image,
      layout: source.layout ?? 'default',
    },
    allOptions: ogImageVariants.map(variantOptions),
    publicOptions: ogImageVariants.filter(variant => variant.isPublic).map(variantOptions),
  }
}
