import { defineTransformer } from '@nuxt/content'

const idPattern = /^(?:blogArticles\/blog|podcast\/podcast)\/(\d{4})(\d{2})(\d{2})\./

export default defineTransformer({
  name: 'blog-articles',
  extensions: ['.md'],
  transform(file: any) {
    // Extract date from filename
    const match = idPattern.exec(file.id)
    if (match) {
      file.published = `${match[1]}-${match[2]}-${match[3]}`
    }
    
    return file
  }
})
