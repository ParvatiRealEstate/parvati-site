// Content checks for the Neighbourhoods page and the header link to it on every
// page (npm test runs these after check-links.mjs). Pages are hand-written, so
// a few regexes are enough, as in check-links.mjs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const PAGE = 'neighbourhoods.html'
const FEATURED = ['Financial District', 'Tribeca', 'Upper West Side', 'Upper East Side']
// Manhattan neighbourhoods the "other" list may name.
const MANHATTAN = new Set([
  'battery park city', 'chelsea', 'chinatown', 'east harlem', 'east village', 'flatiron',
  'gramercy', 'gramercy park', 'greenwich village', 'hamilton heights', 'harlem', "hell's kitchen",
  'inwood', 'kips bay', 'little italy', 'lower east side', 'midtown', 'morningside heights',
  'murray hill', 'noho', 'nolita', 'roosevelt island', 'soho', 'sutton place', 'two bridges',
  'washington heights', 'west village',
])

const readPage = (name) => readFileSync(path.join(ROOT, name), 'utf8').replace(/<!--[\s\S]*?-->/g, '')

const text = (fragment) => fragment
  .replace(/<[^>]*>/g, '')
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&rsquo;/g, '’')
  .replace(/\s+/g, ' ')
  .trim()

// Featured names compare without case or a leading "the".
const normalise = (name) => name.toLowerCase().replace(/^the\s+/, '')

function headerOf(html, name) {
  const m = html.match(/<header class="pv-head[^"]*">[\s\S]*?<\/header>/)
  assert.ok(m, `${name}: no <header class="pv-head"> found`)
  return m[0]
}

const all = (html, tag) => [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi'))]
const attr = (tagHtml, name) => tagHtml.match(new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, 'i'))?.[1]

test('featured neighbourhoods each have a photo from images/ and one line', () => {
  const articles = all(readPage(PAGE), 'article').map((m) => m[0])
  for (const name of FEATURED) {
    const cards = articles.filter((a) => all(a, 'h3').some((h) => text(h[1]) === name))
    assert.equal(cards.length, 1, `${name}: expected exactly one <article> with <h3>${name}</h3>, found ${cards.length}`)
    const card = cards[0]

    const imgs = [...card.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0])
    assert.equal(imgs.length, 1, `${name}: expected one <img>, found ${imgs.length}`)
    const src = attr(imgs[0], 'src')
    assert.match(src ?? '', /^images\/[^/]+$/, `${name}: <img src="${src}"> is not a file in images/`)
    assert.ok(statSync(path.join(ROOT, src), { throwIfNoEntry: false })?.isFile(), `${name}: ${src} is not a file`)

    const paras = all(card, 'p')
    assert.equal(paras.length, 1, `${name}: expected one <p>, found ${paras.length}`)
    assert.doesNotMatch(paras[0][1], /<br\b/i, `${name}: the line contains <br>`)
    assert.notEqual(text(paras[0][1]), '', `${name}: the line is empty`)
  }
})

test('every page header links to the Neighbourhoods page', () => {
  const pages = readdirSync(ROOT).filter((f) => f.endsWith('.html')).sort()
  assert.ok(pages.includes(PAGE), `${PAGE} is missing`)
  assert.ok(pages.length >= 6, `expected at least 6 pages, found ${pages.length}`)
  for (const page of pages) {
    const links = all(headerOf(readPage(page), page), 'a')
      .filter((m) => attr(m[0].match(/^<a\b[^>]*>/i)[0], 'href') === PAGE && text(m[1]) === 'Neighbourhoods')
    assert.ok(links.length > 0, `${page}: header has no <a href="${PAGE}">Neighbourhoods</a>`)
  }
})

test('lists at least 3 other Manhattan neighbourhoods', () => {
  const list = readPage(PAGE).match(/<ul\b[^>]*\bid="other-neighbourhoods"[^>]*>([\s\S]*?)<\/ul>/i)
  assert.ok(list, 'no <ul id="other-neighbourhoods"> found')
  const featured = new Set(FEATURED.map(normalise))
  const seen = new Set()
  for (const [, inner] of all(list[1], 'li')) {
    const name = normalise(text(inner))
    if (name && !featured.has(name)) seen.add(name)
  }
  for (const name of seen) assert.ok(MANHATTAN.has(name), `"${name}" is not on the list of Manhattan neighbourhoods`)
  assert.ok(seen.size >= 3, `expected at least 3 other neighbourhoods, found ${seen.size}`)
})
