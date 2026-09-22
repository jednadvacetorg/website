import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

interface WorkerHarness {
  push: (event: { data?: { json(): unknown }, waitUntil(promise: Promise<unknown>): void }) => void
  notificationclick: (event: { notification: { close(): void, data?: unknown }, waitUntil(promise: Promise<unknown>): void }) => void
  notifications: Array<{ title: string, options: { body: string, data: { url: string } } }>
  focused: number
  opened: string[]
}

const loadWorker = async (windows: Array<{ url: string, focus(): Promise<unknown> }> = []): Promise<WorkerHarness> => {
  const handlers = new Map<string, (event: never) => void>()
  const notifications: WorkerHarness['notifications'] = []
  const opened: string[] = []
  let focused = 0
  const source = await readFile(new URL('../public/notification-sw.js', import.meta.url), 'utf8')
  const context = {
    URL,
    self: {
      location: { origin: 'https://jednadvacet.org' },
      addEventListener: (type: string, handler: (event: never) => void) => handlers.set(type, handler),
      registration: { showNotification: async (title: string, options: WorkerHarness['notifications'][number]['options']) => { notifications.push({ title, options }) } },
    },
    clients: {
      matchAll: async () => windows.map(window => ({ ...window, focus: async () => { focused += 1; return window.focus() } })),
      openWindow: async (url: string) => { opened.push(url) },
    },
  }
  vm.runInNewContext(source, context)
  return {
    push: handlers.get('push') as WorkerHarness['push'],
    notificationclick: handlers.get('notificationclick') as WorkerHarness['notificationclick'],
    notifications,
    get focused() { return focused },
    opened,
  }
}

const settled = async (run: (waitUntil: (promise: Promise<unknown>) => void) => void) => {
  let pending: Promise<unknown> | undefined
  run(promise => { pending = promise })
  await pending
}

test('service worker always shows a bounded notification and sanitizes its click URL', async () => {
  const worker = await loadWorker()
  await settled(waitUntil => worker.push({
    data: { json: () => ({ title: 'Nová událost', body: 'Bitcoinové setkání', url: 'https://evil.example/steal' }) },
    waitUntil,
  }))
  await settled(waitUntil => worker.push({ data: { json: () => { throw new Error('malformed') } }, waitUntil }))

  assert.deepEqual(JSON.parse(JSON.stringify(worker.notifications)), [
    { title: 'Nová událost', options: { body: 'Bitcoinové setkání', data: { url: '/kalendar' } } },
    { title: 'Jednadvacet.org', options: { body: 'Máš nové upozornění na událost.', data: { url: '/kalendar' } } },
  ])
})

test('service worker focuses a same-origin window and never opens an unsafe URL', async () => {
  const worker = await loadWorker([{ url: 'https://jednadvacet.org/brno', focus: async () => {} }])
  let closed = 0
  await settled(waitUntil => worker.notificationclick({ notification: { close: () => { closed += 1 }, data: { url: 'javascript:alert(1)' } }, waitUntil }))

  assert.equal(closed, 1)
  assert.equal(worker.focused, 1)
  assert.deepEqual(worker.opened, [])
})

test('service worker opens only a safe public URL when no existing window is available', async () => {
  const worker = await loadWorker()
  await settled(waitUntil => worker.notificationclick({ notification: { close: () => {}, data: { url: '/notifications/manage/token' } }, waitUntil }))

  assert.deepEqual(worker.opened, ['/notifications/manage/token'])
})
