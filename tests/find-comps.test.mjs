// Checks data/find-comps.mjs: the PS-5 comps run on data/sales.csv, the filter
// window, ranking, skipped rows, byte-identical reruns and the guardrails
// (read-only input, writes only under --out-dir, no clock or network, no deps).
// Every fixture and out-dir lives under an OS temp dir, never in the repo.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { COLUMNS, FICTIONAL_NOTE } from '../data/generate-sales.mjs'
import { CSV_HEADER, WEIGHTS } from '../data/find-comps.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLI = path.join(ROOT, 'data', 'find-comps.mjs')
const SALES = path.join(ROOT, 'data', 'sales.csv')
const TMP = mkdtempSync(path.join(os.tmpdir(), 'find-comps-'))
after(() => rmSync(TMP, { recursive: true, force: true }))

const RUN_DATE = '2026-11-05'
// The PS-5 subject, exactly as the work item states it.
const PS5 = ['--neighbourhood', 'Upper West Side', '--type', 'co-op', '--sqft', '1100', '--beds', '2',
  '--baths', '2', '--monthly', '2400', '--building', 'prewar elevator']

let dirs = 0
const tempDir = (name) => { const d = path.join(TMP, `${name}-${++dirs}`); mkdirSync(d); return d }

function run(args, { cwd = ROOT } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' })
}

function runOk(args) {
  const outDir = tempDir('out')
  const r = run([...args, '--out-dir', outDir])
  assert.equal(r.status, 0, r.stderr)
  return {
    outDir,
    report: readFileSync(path.join(outDir, 'report.md'), 'utf8'),
    csv: readFileSync(path.join(outDir, 'comps.csv'), 'utf8'),
  }
}

// Minimal CSV reader that honours quoted fields.
function parseCsv(text) {
  const rows = []
  for (const line of text.split('\n').filter((l) => l !== '')) {
    const cells = []
    let cell = ''
    let quoted = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') { cell += '"'; i++ } else if (ch === '"') quoted = false
        else cell += ch
      } else if (ch === '"') quoted = true
      else if (ch === ',') { cells.push(cell); cell = '' } else cell += ch
    }
    cells.push(cell)
    rows.push(cells)
  }
  return rows
}

// Both outputs as rows of the 7 fields: rank, address+unit, price, ppsf, date, score, reason.
const money = (s) => Number(s.replace(/[$,]/g, ''))

function reportRows(report) {
  return report.split('\n').filter((l) => /^\| \d+ \|/.test(l)).map((l) => {
    const c = l.slice(2, -2).split(' | ')
    return { rank: Number(c[0]), addressUnit: c[1], price: money(c[2]), ppsf: money(c[3]), date: c[4], score: c[5], reason: c[6] }
  })
}

function csvRows(csv) {
  const [header, ...rows] = parseCsv(csv)
  assert.equal(header.join(','), CSV_HEADER)
  return rows.map((c) => ({
    rank: Number(c[0]), addressUnit: `${c[1]}, ${c[2]}`, price: Number(c[3]), ppsf: Number(c[4]), date: c[5], score: c[6], reason: c[7],
  }))
}

function checkRanking(rows) {
  assert.deepEqual(rows.map((r) => r.rank), rows.map((_, i) => i + 1))
  for (let i = 1; i < rows.length; i++) {
    assert.ok(Number(rows[i].score) <= Number(rows[i - 1].score), `rank ${rows[i].rank} scores above rank ${rows[i - 1].rank}`)
  }
}

// Fixture CSVs: the note line, the header, then rows built from `base` plus overrides.
const base = {
  address: 'Broadway at West 79th Street', neighbourhood: 'Upper West Side', type: 'co-op', building: 'prewar elevator',
  sq_ft: 1100, bedrooms: 2, bathrooms: 2, monthly_charges_usd: 2400, sale_price_usd: 1400000, sale_date: '2026-06-01',
}
const fixtureRow = (i, over = {}) => COLUMNS.map((c) => String(({ sale_id: `FX-${i}`, unit: `${i}A`, ...base, ...over })[c])).join(',')

function writeFixture(lines) {
  const file = path.join(tempDir('in'), 'sales.csv')
  writeFileSync(file, [FICTIONAL_NOTE, COLUMNS.join(','), ...lines].join('\n') + '\n')
  return file
}

const salesSha = () => createHash('sha256').update(readFileSync(SALES)).digest('hex')
const shaBefore = salesSha()
const ps5 = runOk(['--run-date', RUN_DATE, ...PS5])

test('PS-5 run: report.md and comps.csv list the same 20 rows with all 7 fields', () => {
  const rep = reportRows(ps5.report)
  const csv = csvRows(ps5.csv)
  assert.equal(rep.length, 20)
  assert.equal(csv.length, 20)
  assert.deepEqual(csv, rep)
  for (const row of rep) {
    for (const [k, v] of Object.entries(row)) {
      assert.ok(v !== '' && !Number.isNaN(v), `rank ${row.rank}: ${k} is empty`)
    }
  }
  assert.match(ps5.report, /^Skipped rows: 0$/m)
  assert.match(ps5.report, /^Fewer than 20 rows passed: no$/m)
})

test('PS-5 run: rows match the filter and window; report states run date, weights, pass count', () => {
  const input = new Map(readFileSync(SALES, 'utf8').split('\n').slice(2).filter(Boolean).map((l) => {
    const cells = l.split(',')
    const sale = Object.fromEntries(COLUMNS.map((c, i) => [c, cells[i]]))
    return [`${sale.address}, ${sale.unit}`, sale]
  }))
  for (const row of csvRows(ps5.csv)) {
    const sale = input.get(row.addressUnit)
    assert.ok(sale, `${row.addressUnit} is not in data/sales.csv`)
    assert.equal(sale.neighbourhood, 'Upper West Side')
    assert.equal(sale.type, 'co-op')
    assert.equal(sale.sale_date, row.date)
    assert.ok(row.date > '2024-11-05' && row.date <= RUN_DATE, `${row.date} is outside the window`)
  }
  assert.match(ps5.report, /^- Run date: 2026-11-05$/m)
  for (const [name, weight] of Object.entries(WEIGHTS)) {
    assert.match(ps5.report, new RegExp(`^\\| ${name} \\| ${weight} \\|`, 'm'), `weight ${name} ${weight}`)
  }
  // 44 is every Upper West Side co-op the seeded generator writes; reseeding
  // data/generate-sales.mjs will change it and should fail here on purpose.
  assert.match(ps5.report, /^Rows passing filter: 44$/m)
})

test('window: after run date minus 24 months, on or before run date', () => {
  const file = writeFixture([
    fixtureRow(1, { sale_date: '2024-11-05' }),
    fixtureRow(2, { sale_date: '2024-11-06' }),
    fixtureRow(3, { sale_date: '2026-11-05' }),
    fixtureRow(4, { sale_date: '2026-11-06' }),
  ])
  const { report, csv } = runOk(['--in', file, '--run-date', RUN_DATE, ...PS5])
  assert.deepEqual(csvRows(csv).map((r) => r.date).sort(), ['2024-11-06', '2026-11-05'])
  assert.match(report, /^Rows passing filter: 2$/m)
})

test('PS-5 run: ranks 1..N, scores never rise, price per sq ft within $1 in both files', () => {
  const input = new Map(readFileSync(SALES, 'utf8').split('\n').slice(2).filter(Boolean).map((l) => {
    const c = l.split(',')
    return [`${c[1]}, ${c[2]}`, Number(c[6])]
  }))
  for (const rows of [reportRows(ps5.report), csvRows(ps5.csv)]) {
    checkRanking(rows)
    for (const r of rows) {
      const sqft = input.get(r.addressUnit)
      assert.ok(Math.abs(r.ppsf - r.price / sqft) <= 1, `rank ${r.rank}: ${r.ppsf} vs ${r.price}/${sqft}`)
    }
  }
})

test('a blank-cell row is skipped and listed; fewer than the limit outputs every qualifying row', () => {
  const good = [1, 2, 3, 4, 5].map((i) => fixtureRow(i, { sq_ft: 1000 + i * 20 }))
  const blank = fixtureRow(9, { sq_ft: '' })
  // Line 1 is the note and line 2 the header, so the blank row is file line 5.
  const file = writeFixture([good[0], good[1], blank, good[2], good[3], good[4], fixtureRow(6, { type: 'condo' })])
  const { report, csv } = runOk(['--in', file, '--run-date', RUN_DATE, ...PS5])
  const want = [1, 2, 3, 4, 5].map((i) => `${base.address}, ${i}A`).sort()
  assert.deepEqual(csvRows(csv).map((r) => r.addressUnit).sort(), want)
  assert.deepEqual(reportRows(report).map((r) => r.addressUnit).sort(), want)
  assert.match(report, /^Rows passing filter: 5$/m)
  assert.match(report, /^Fewer than 20 rows passed: yes$/m)
  assert.match(report, /^Skipped rows: 1$/m)
  assert.match(report, /^- line 5: blank sq_ft$/m)
  assert.equal(report.match(/^- line \d+:/gm).length, 1)
})

test('a clean fixture reports 0 skipped rows and lists none', () => {
  const file = writeFixture([1, 2, 3].map((i) => fixtureRow(i)))
  const { report } = runOk(['--in', file, '--run-date', RUN_DATE, ...PS5])
  assert.match(report, /^Skipped rows: 0$/m)
  assert.doesNotMatch(report, /^- line \d+:/m)
})

test('two runs with identical inputs write byte-identical files', () => {
  const second = runOk(['--run-date', RUN_DATE, ...PS5])
  for (const name of ['report.md', 'comps.csv']) {
    const a = readFileSync(path.join(ps5.outDir, name))
    const b = readFileSync(path.join(second.outDir, name))
    assert.ok(a.equals(b), `${name} differs between runs`)
  }
})

test('writes only report.md and comps.csv under --out-dir; no --out-dir writes nothing', () => {
  assert.deepEqual(readdirSync(ps5.outDir).sort(), ['comps.csv', 'report.md'])
  const cwd = tempDir('cwd')
  const r = run(['--run-date', RUN_DATE, ...PS5], { cwd })
  assert.equal(r.status, 2)
  assert.notEqual(r.stderr.trim(), '')
  assert.deepEqual(readdirSync(cwd), [])
  assert.equal(existsSync(path.join(ROOT, 'data', 'report.md')), false)
  assert.equal(existsSync(path.join(ROOT, 'data', 'comps.csv')), false)
})

test('source reads no clock, makes no network calls and reads only the input file', () => {
  const src = readFileSync(CLI, 'utf8')
  for (const re of [/Date\.now/, /new Date\(\s*\)/, /(?<!new\s+)\bDate\(\s*\)/, /\bfetch\b/,
    /node:http\b/, /node:https/, /node:http2/, /node:net/, /node:dns/, /node:tls/, /node:dgram/, /child_process/]) {
    assert.doesNotMatch(src, re)
  }
  assert.equal(src.match(/readFileSync\(/g).length, 1)
})

test('data/sales.csv is unchanged by a run', () => {
  assert.equal(salesSha(), shaBefore)
})

test('package.json adds no npm dependencies', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.dependencies, undefined)
  assert.equal(pkg.devDependencies, undefined)
})
