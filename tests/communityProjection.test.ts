import assert from 'node:assert/strict'
import test from 'node:test'
import { projectCommunities } from '../app/composables/content.ts'

test('community projection orders priorities and keeps prioritized cities in regions', () => {
  const projection = projectCommunities([
    { path: '/zlin', title: 'Zlín', region: 'Zlínský' },
    { path: '/praha', title: 'Praha', region: 'Středočeský', priority: 0 },
    { path: '/brno', title: 'Brno', region: 'Jihomoravský', priority: '1' },
    { path: '/ostrava', title: 'Ostrava', region: 'Moravskoslezský', priority: 2 },
  ])

  assert.deepEqual(projection.prioritized.map(community => community.title), [
    'Praha',
    'Brno',
    'Ostrava',
  ])
  assert.deepEqual(projection.regions.map(group => group.region), [
    'Jihomoravský',
    'Moravskoslezský',
    'Středočeský',
    'Zlínský',
  ])
  assert.equal(
    projection.regions.find(group => group.region === 'Středočeský')?.communities[0]?.title,
    'Praha',
  )
})

test('community with multiple regions is listed in each region once', () => {
  const projection = projectCommunities([
    { path: '/hradubice', title: 'Hradec Králové a Pardubice', region: ['Královéhradecký', 'Pardubický'], priority: 3 },
    { path: '/svitavy', title: 'Svitavy', region: 'Pardubický' },
  ])

  assert.deepEqual(projection.prioritized.map(community => community.path), ['/hradubice'])
  assert.deepEqual(
    projection.regions.map(group => [group.region, group.communities.map(community => community.path)]),
    [
      ['Královéhradecký', ['/hradubice']],
      ['Pardubický', ['/hradubice', '/svitavy']],
    ],
  )
})

test('community projection orders cities using Czech collation', () => {
  const projection = projectCommunities([
    { path: '/zatec', title: 'Žatec', region: 'Ústecký' },
    { path: '/chomutov', title: 'Chomutov', region: 'Ústecký' },
    { path: '/ceska-kamenice', title: 'Česká Kamenice', region: 'Ústecký' },
  ])

  assert.deepEqual(projection.regions[0]?.communities.map(community => community.title), [
    'Česká Kamenice',
    'Chomutov',
    'Žatec',
  ])
})
