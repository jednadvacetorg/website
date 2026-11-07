import type { MinimarkNode, MinimarkTree } from '@nuxt/content'

const escapeHtml = (value: string) => value.replace(/[<>&"']/g, character => ({
  '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;',
})[character]!)

const tags = new Set([
  'p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li',
  'strong', 'em', 'b', 'i', 'blockquote', 'pre', 'code', 'hr',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'del', 'sup', 'sub',
])

// Feed readers cannot render Vue components or use the site's styles.
export function renderPodcastBody(body: MinimarkTree | undefined, pageUrl: string): string {
  const url = (value: unknown) => {
    if (typeof value !== 'string' || !value.trim()) return undefined
    try {
      const resolved = new URL(value, pageUrl)
      return ['https:', 'http:'].includes(resolved.protocol) ? escapeHtml(resolved.href) : undefined
    } catch {
      return undefined
    }
  }

  const render = (node: MinimarkNode): string => {
    if (typeof node === 'string') return escapeHtml(node)
    const [tag, props, ...children] = node
    if (['script', 'style', 'template'].includes(tag)) return ''
    const content = children.map(render).join('')
    if (tag === 'a' || tag === 'u-button') {
      const href = url(props.href ?? props.to)
      const label = content || escapeHtml(String(props.label ?? ''))
      return href ? `<a href="${href}">${label || href}</a>` : label
    }
    if (['iframe', 'video', 'audio', 'img'].includes(tag)) {
      const href = url(props.src)
      const label = escapeHtml(String(props.title ?? props.alt ?? props.src ?? ''))
      return href ? `<p><a href="${href}">${label || href}</a></p>` : content
    }
    if (!tags.has(tag)) return content
    if (tag === 'br' || tag === 'hr') return `<${tag}>`
    const start = tag === 'ol' && /^\d+$/.test(String(props.start ?? ''))
      ? ` start="${props.start}"` : ''
    return `<${tag}${start}>${content}</${tag}>`
  }

  return body?.value.map(render).join('') ?? ''
}
