import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { MinimarkNode } from '@nuxt/content'
import { renderPodcastBody } from '../server/utils/podcastBody.ts'

const render = (...value: MinimarkNode[]) => renderPodcastBody({ type: 'minimark', value }, 'https://jednadvacet.org/blog/test')

test('podcast body preserves semantic formatting without site-specific styles', () => {
  assert.equal(render(
    ['h2', { id: 'tema', class: 'heading' }, 'Téma'],
    ['p', {}, ['strong', {}, 'Bitcoin'], ' & ', ['em', {}, 'komunita']],
    ['ol', { start: 3 }, ['li', {}, 'První'], ['li', {}, 'Druhý']],
    ['blockquote', {}, ['p', {}, 'Citace'], ['br', {}], ['code', {}, '<code>']],
  ), '<h2>Téma</h2><p><strong>Bitcoin</strong> &amp; <em>komunita</em></p><ol start="3"><li>První</li><li>Druhý</li></ol><blockquote><p>Citace</p><br><code>&lt;code&gt;</code></blockquote>')
})

test('podcast links resolve relative to the article and escape attributes', () => {
  assert.equal(render(['a', { href: '/brno?a=1&b=2', onclick: 'alert(1)' }, 'Brno']),
    '<a href="https://jednadvacet.org/brno?a=1&amp;b=2">Brno</a>')
  assert.equal(render(['a', { href: '#tema' }, 'Téma']),
    '<a href="https://jednadvacet.org/blog/test#tema">Téma</a>')
})

test('podcast body unwraps components and replaces embeds with links', () => {
  assert.equal(render(
    ['note', {}, ['p', {}, 'Poznámka']],
    ['u-button', { to: '/kalendar', label: 'Kalendář' }],
    ['iframe', { src: 'https://www.youtube.com/embed/test', title: 'Video' }],
    ['img', { src: '/images/test.webp', alt: 'Obrázek' }],
  ), '<p>Poznámka</p><a href="https://jednadvacet.org/kalendar">Kalendář</a><p><a href="https://www.youtube.com/embed/test">Video</a></p><p><a href="https://jednadvacet.org/images/test.webp">Obrázek</a></p>')
})

test('podcast body drops active content and unsafe URLs', () => {
  assert.equal(render(
    ['script', {}, 'alert(1)'], ['style', {}, 'body { display: none }'],
    ['a', { href: 'javascript:alert(1)' }, 'Text'],
    ['img', { src: 'data:text/html,unsafe' }],
    ['a', { href: 'http://[' }, 'Neplatný odkaz'],
  ), 'TextNeplatný odkaz')
  assert.equal(renderPodcastBody(undefined, 'https://jednadvacet.org'), '')
})
