// Filenames specify a Czech publication day, not a UTC timestamp.
export const isPublishedBlogFile = (file: string, now = new Date()): boolean => {
  const date = file.replaceAll('\\', '/').split('/').pop()?.match(/^(\d{4})(\d{2})(\d{2})\./)
  if (!date) return true

  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Prague',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
  return `${date[1]}-${date[2]}-${date[3]}` <= day
}
