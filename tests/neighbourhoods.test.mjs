// The Neighbourhoods page and its header link (PS-8). Run by npm test after
// check-links.mjs. No dependencies: the site's markup is hand-written and
// consistent, so these checks parse it with regular expressions.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PAGE = 'neighbourhoods.html'
const HOODS = ['Financial District', 'Tribeca', 'Upper West Side', 'Upper East Side']

// Every header, in document order, as [text, href]. The phone number is locked
// here on purpose: the header must stay exactly as it was, plus Neighbourhoods.
const HEADER = [
  ['Buy', 'buy.html'],
  ['Sell', 'sell.html'],
  ['Neighbourhoods', 'neighbourhoods.html'],
  ['PARVATI REAL ESTATE MANHATTAN', 'index.html'],
  ['About', 'about.html'],
  ['Contact', 'contact.html'],
  ['(212) 555-0147', 'contact.html'],
]

function sitePages() {
  return readdirSync(ROOT).filter((f) => f.endsWith('.html')).sort()
}

function read(file) {
  return readFileSync(path.join(ROOT, file), 'utf8').replace(/<!--[\s\S]*?-->/g, '')
}

function text(html) {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, 'i'))
  return m ? m[1] : null
}

function hasClass(tag, cls) {
  return (attr(tag, 'class') ?? '').split(/\s+/).includes(cls)
}

function headerHtml(html) {
  const m = html.match(/<header\b[\s\S]*?<\/header>/i)
  return m ? m[0] : ''
}

function headerLinks(html) {
  return [...headerHtml(html).matchAll(/(<a\b[^>]*>)([\s\S]*?)<\/a>/gi)].map(([, open, inner]) => [text(inner), attr(open, 'href')])
}

// Each <section> carrying the pv-hood class token, in document order.
function sections(html) {
  return [...html.matchAll(/(<section\b[^>]*>)([\s\S]*?)<\/section>/gi)]
    .filter(([, open]) => hasClass(open, 'pv-hood'))
    .map(([, , inner], i, all) => ({
      end: all[i].index + all[i][0].length,
      name: text((inner.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i) ?? [])[1] ?? ''),
      imgs: [...inner.matchAll(/<img\b[^>]*>/gi)].map(([tag]) => attr(tag, 'src')),
      paras: [...inner.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map(([, p]) => p),
    }))
}

test('the site has the Neighbourhoods page among at least 6 pages', () => {
  const pages = sitePages()
  assert.ok(pages.includes(PAGE), `${PAGE} is missing`)
  assert.ok(pages.length >= 6, `only ${pages.length} pages found`)
})

test('every page header has exactly one Neighbourhoods link to neighbourhoods.html', () => {
  for (const page of sitePages()) {
    const links = headerLinks(read(page)).filter(([t]) => t === 'Neighbourhoods')
    assert.deepEqual(links, [['Neighbourhoods', PAGE]], `${page} header`)
  }
})

test('every page header keeps its links and order, with Neighbourhoods after Sell', () => {
  for (const page of sitePages()) {
    assert.deepEqual(headerLinks(read(page)), HEADER, `${page} header`)
  }
})

test('the page has one h1 reading "Neighbourhoods we know"', () => {
  const h1s = [...read(PAGE).matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map(([, h]) => text(h))
  assert.deepEqual(h1s, ['Neighbourhoods we know'])
})

test('the page has the four neighbourhood sections, each with one photo and one line', () => {
  const found = sections(read(PAGE))
  assert.deepEqual(found.map((s) => s.name), HOODS)
  for (const s of found) {
    assert.equal(s.imgs.length, 1, `${s.name}: images`)
    assert.match(s.imgs[0] ?? '', /^images\/[^/]+$/, `${s.name}: image src`)
    assert.ok(existsSync(path.join(ROOT, s.imgs[0])), `${s.name}: ${s.imgs[0]} does not exist`)
    assert.equal(s.paras.length, 1, `${s.name}: paragraphs`)
    assert.doesNotMatch(s.paras[0], /<br\b/i, `${s.name}: description must be one line`)
    assert.ok(text(s.paras[0]).length > 0, `${s.name}: description is empty`)
  }
})

test('the page lists at least 3 other neighbourhoods after the four sections', () => {
  const html = read(PAGE)
  const found = sections(html)
  assert.equal(found.length, HOODS.length)
  const list = html.slice(found.at(-1).end).match(/<ul\b[^>]*>([\s\S]*?)<\/ul>/i)
  assert.ok(list, 'no <ul> after the last section')
  const items = [...list[1].matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map(([, li]) => text(li))
  assert.ok(items.length >= 3, `only ${items.length} other neighbourhoods`)
  for (const item of items) {
    assert.ok(item.length > 0, 'empty list item')
    assert.ok(!HOODS.includes(item), `${item} repeats one of the four sections`)
  }
})
