export const socialLinks = [
  'nprofile1qqsrugq6wmqv2k53z7ugqnqq5dq4n9g5vfw7skc84mlwlfad7wrg5ksvqhljh',
  'https://x.com/jednadvacetorg',
  'https://www.facebook.com/profile.php?id=61573496275870',
  'https://www.instagram.com/jednadvacetorg',
  'https://www.youtube.com/@Jednadvacet',
  'https://chat.whatsapp.com/B8fQowgJLf2Bo1DCXOId0n',
]

export const podcast = {
  cover: '/images/podcast/channel-cover.jpeg',
  platforms: {
    rss: { label: 'Zkopírovat odkaz na podcast RSS. Slouží pro jakoukoliv standardní aplikaci pro podcasty, bez závislosti na jejím katalogu pořadů.', icon: 'i-lucide-rss', to: '/podcast.xml' },
    // TODO: Doplň adresy pořadu po zveřejnění v podcastových aplikacích.
    applePodcasts: { label: 'Sleduj na Apple Podcasts', icon: 'i-simple-icons-applepodcasts', to: 'https://podcasts.apple.com/us/channel/jednadvacet-podcast/id6836865181' },
    spotify: { label: 'Sleduj na Spotify', icon: 'i-simple-icons-spotify', to: 'https://open.spotify.com/show/7jS7Fnw5j6j6BUCRUyjs4a' },
    fountain: { label: 'Sleduj na Fountain', image: '/icons/fountain.svg', to: undefined as string | undefined },
    youtube: { label: 'Sleduj na YouTube', icon: 'i-simple-icons-youtube', to: 'https://www.youtube.com/@Jednadvacet' },
  },
}
