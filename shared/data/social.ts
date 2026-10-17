export const socialLinks = [
  'nprofile1qqsrugq6wmqv2k53z7ugqnqq5dq4n9g5vfw7skc84mlwlfad7wrg5ksvqhljh',
  'https://x.com/jednadvacetorg',
  'https://www.facebook.com/profile.php?id=61573496275870',
  'https://www.instagram.com/jednadvacetorg',
  'https://chat.whatsapp.com/B8fQowgJLf2Bo1DCXOId0n',
]

export const podcast = {
  // Přidej čtvercový obal 3000 × 3000 px do public/images/podcast/cover.jpg a nastav '/images/podcast/cover.jpg'.
  cover: undefined as string | undefined,
  platforms: {
    rss: { label: 'Sleduj přes RSS', icon: 'i-lucide-rss', to: '/podcast.xml' },
    // TODO: Doplň adresy pořadu po zveřejnění v podcastových aplikacích.
    applePodcasts: { label: 'Sleduj na Apple Podcasts', icon: 'i-simple-icons-applepodcasts', to: undefined as string | undefined },
    spotify: { label: 'Sleduj na Spotify', icon: 'i-simple-icons-spotify', to: undefined as string | undefined },
    fountain: { label: 'Sleduj na Fountain', image: '/icons/fountain.svg', to: undefined as string | undefined },
  },
}
