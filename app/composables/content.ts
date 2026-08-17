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
      .select('path', 'title', 'region')
      .all()
  })
}
