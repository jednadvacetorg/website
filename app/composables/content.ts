export const useDataBlogCategories = () => {
  return useAsyncData('blog-categories', () => {
    return queryCollection('blogCategories')
      .order('id', 'ASC')
      .select('path', 'title')
      .all()
  })
}

export const useArticleCategories = (categoriesStems?: string[]) => {
  const { data: blogCategories } = useDataBlogCategories()
  return computed(() => {
    if (!categoriesStems?.length) return blogCategories.value ?? []
    return blogCategories.value?.filter(category => categoriesStems.includes(category.path.substring(6)))
  })
}

export const useDataCommunities = () => {
  return useAsyncData('communities', () => {
    return queryCollection('communities')
      .all()
      .then(communities => communities.filter(community => !community.hidden))
  })
}

export interface CommunitySummary {
  path: string
  title: string
  region: string | string[]
  priority?: number | string | null
}

export interface CommunityRegionGroup {
  region: string
  communities: CommunitySummary[]
}

export interface CommunityProjection {
  prioritized: CommunitySummary[]
  regions: CommunityRegionGroup[]
}

const czechCollator = new Intl.Collator('cs')

export const projectCommunities = (items: readonly CommunitySummary[]): CommunityProjection => {
  const prioritized = items
    .flatMap((item) => {
      const priority = typeof item.priority === 'number'
        ? item.priority
        : typeof item.priority === 'string' && item.priority.trim()
          ? Number(item.priority)
          : Number.NaN
      return Number.isFinite(priority) ? [{ ...item, priority }] : []
    })
    .sort((a, b) => a.priority - b.priority
      || czechCollator.compare(a.title, b.title)
      || a.path.localeCompare(b.path))

  const grouped = items.reduce<Map<string, CommunitySummary[]>>((groups, item) => {
    for (const region of new Set([item.region].flat())) {
      const communities = groups.get(region) ?? []
      communities.push(item)
      groups.set(region, communities)
    }
    return groups
  }, new Map())

  const regions = Array.from(grouped, ([region, communities]) => ({
    region,
    communities: communities.slice().sort((a, b) =>
      czechCollator.compare(a.title, b.title) || a.path.localeCompare(b.path)),
  })).sort((a, b) => czechCollator.compare(a.region, b.region))

  return { prioritized, regions }
}

export const useCommunityProjection = async () => {
  const { data, error } = await useDataCommunities()
  const projection = computed(() => projectCommunities(data.value ?? []))

  return { data, error, projection }
}
