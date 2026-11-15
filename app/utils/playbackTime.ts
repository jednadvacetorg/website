export function parsePlaybackTime(value: string | null | undefined): number | null {
  if (!value) return null
  if (/^\d+$/.test(value)) {
    const seconds = Number(value)
    return Number.isSafeInteger(seconds) ? seconds : null
  }
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value)
  if (!match) return null
  const seconds = Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0)
  return Number.isSafeInteger(seconds) ? seconds : null
}

export function playbackHash(time: number): string {
  const seconds = Math.max(0, Math.floor(time))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor(seconds % 3600 / 60)
  return `#t=${hours ? `${hours}h` : ''}${minutes ? `${minutes}m` : ''}${seconds % 60 || (!hours && !minutes) ? `${seconds % 60}s` : ''}`
}

export function youtubeVideoId(value: string): string | null {
  try {
    const url = new URL(value)
    if (!['https:', 'http:'].includes(url.protocol)) return null
    const id = url.hostname === 'youtu.be' ? url.pathname.split('/')[1]
      : ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'www.youtube-nocookie.com'].includes(url.hostname)
        ? url.pathname === '/watch' ? url.searchParams.get('v') : /^\/(?:embed|live|shorts)\/([^/]+)/.exec(url.pathname)?.[1]
        : null
    return id && /^[\w-]{11}$/.test(id) ? id : null
  } catch {
    return null
  }
}
