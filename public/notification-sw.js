const safeUrl = value => {
  try {
    const url = new URL(value, self.location.origin)
    return url.origin === self.location.origin ? `${url.pathname}${url.search}` : '/kalendar'
  } catch { return '/kalendar' }
}

self.addEventListener('push', event => {
  let message = {}
  try { message = event.data?.json() ?? {} } catch {}
  const title = typeof message.title === 'string' && message.title.length <= 120 ? message.title : 'Jednadvacet.org'
  const body = typeof message.body === 'string' && message.body.length <= 240 ? message.body : 'Máš nové upozornění na událost.'
  event.waitUntil(self.registration.showNotification(title, { body, data: { url: safeUrl(message.url) } }))
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  const url = safeUrl(event.notification.data?.url)
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windows => {
    const current = windows.find(client => new URL(client.url).origin === self.location.origin)
    return current ? current.focus() : clients.openWindow(url)
  }))
})
