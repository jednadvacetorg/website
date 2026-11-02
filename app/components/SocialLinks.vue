<script setup lang="ts">
import { h, type VNode } from 'vue'

const IconNostr = () => h(
  'svg',
  { xmlns: 'http://www.w3.org/2000/svg', viewBox: '0 0 24 24' },
  [
    h(
      'path',
      {
        'fill': 'currentColor',
        'd': 'm24 23c0 0.5-0.4 0.9-0.9 0.9h-10.2c-0.5 0-0.9-0.4-0.9-0.9v-2.3c0-2.9 0.3-5.6 1-6.9 0.3-0.7 1-1.2 1.7-1.4 1.4-0.4 3.8-0.1 4.8-0.1 0 0 3.1 0.1 3.1-1.7 0-1.7-1.4-1.3-1.4-1.3-1.5 0.1-2.7 0-3.4-0.3-1.3-0.5-1.3-1.4-1.3-1.7-0.1-3.5-5.2-3.9-9.8-3-4.9 0.9 0.1 8 0.1 17.5v1.3c0 0.4-0.4 0.8-0.8 0.8h-5.1c-0.5 0-0.9-0.4-0.9-0.9v-21.7c0-0.5 0.4-0.9 0.9-0.9h4.8c0.4 0 0.8 0.4 0.8 0.9 0 0.7 0.8 1.1 1.4 0.7 1.7-1.3 3.9-1.9 6.4-1.9 5.5 0 9.7 3.2 9.7 10.4v12.5zm-9.2-15.1c0-1-0.8-1.8-1.8-1.8-1 0-1.8 0.8-1.8 1.8 0 1 0.8 1.8 1.8 1.8 1 0 1.8-0.8 1.8-1.8z'
      }
    )
  ]
)

const props = defineProps<{
  links: string[]
}>()

const socialPatterns: Array<{ pattern: RegExp, icon: string | (() => VNode), label: string, transform?: (link: string) => string }> = [
  { pattern: /^(nprofile|npub)/, icon: IconNostr, label: 'Nostr', transform: (link) => `https://nostr.com/${link}` },
  { pattern: /^https?:\/\/(www\.)?x\.com\//, icon: 'i-simple-icons-x', label: 'X' },
  { pattern: /^https?:\/\/(www\.)?facebook\.com\//, icon: 'i-simple-icons-facebook', label: 'Facebook' },
  { pattern: /^https?:\/\/(www\.)?instagram\.com\//, icon: 'i-simple-icons-instagram', label: 'Instagram' },
  { pattern: /^https?:\/\/(www\.)?youtube\.com\//, icon: 'i-simple-icons-youtube', label: 'YouTube' },
  { pattern: /^https?:\/\/github\.com\//, icon: 'i-simple-icons-github', label: 'GitHub' },
  { pattern: /^https?:\/\/chat\.whatsapp\.com\//, icon: 'i-simple-icons-whatsapp', label: 'WhatsApp' },
  { pattern: /^https?:\/\/signal\.(me|group)\//, icon: 'i-simple-icons:signal', label: 'Signal' },
  { pattern: /^[^@]+@[^@]+\.[^@]+$/, icon: 'i-streamline-mail-send-envelope', label: 'Email', transform: (link) => `mailto:${link}` },
  { pattern: /^https?:\/\//, icon: 'i-streamline-web', label: 'Web' },
]

const socialLinks = computed(() => {
  return props.links
    .map(link => {
      const match = socialPatterns.find(p => p.pattern.test(link))
      if (!match) return null
      const to = match.transform ? match.transform(link) : link
      return { to, icon: match.icon, label: match.label }
    })
    .filter(Boolean) as Array<{ to: string, icon: string | (() => VNode), label: string }>
})
</script>

<template>
  <div class="flex items-center gap-2">
    <UButton
      v-for="social in socialLinks"
      :key="social.to"
      :icon="social.icon"
      :to="social.to"
      target="_blank"
      variant="ghost"
      color="neutral"
      :aria-label="social.label"
    />
  </div>
</template>
