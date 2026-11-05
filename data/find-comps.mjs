// Ranks comparable sales for a subject apartment from data/sales.csv and
// writes report.md and comps.csv to --out-dir.
//
//   node data/find-comps.mjs --run-date 2026-11-05 --out-dir <dir> \
//     --neighbourhood "Upper West Side" --type co-op --sqft 1100 --beds 2 \
//     --baths 2 --monthly 2400 --building "prewar elevator" [--in <file>] [--limit 20]
//
// The input is opened read-only and nothing is written outside --out-dir. All
// dates come from --run-date (never the system clock), and the outputs hold no
// timestamps or absolute paths, so the same arguments always write the same bytes.
//
// Exit codes: 0 success, 1 input cannot be read or has the wrong header,
// 2 bad or missing argument.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { COLUMNS } from './generate-sales.mjs'

export const DEFAULT_IN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sales.csv')
export const DEFAULT_IN_LABEL = 'data/sales.csv'
export const DEFAULT_LIMIT = 20
export const WINDOW_MONTHS = 24

// Points taken off a perfect 100 when a comp differs as much as possible on
// that measure. Each difference is scaled to 0..1 (see scoreRow); they sum to 100.
export const WEIGHTS = Object.freeze({ sqft: 30, beds: 15, baths: 10, monthly: 15, building: 10, recency: 20 })
const WEIGHT_NOTES = {
  sqft: '|sq ft difference| / subject sq ft',
  beds: '|bedroom difference| / 2',
  baths: '|bathroom difference| / 2',
  monthly: '|monthly difference| / subject monthly',
  building: '0 same building type, 0.5 same era or access, 1 otherwise',
  recency: 'days before run date / 730',
}

const NUMERIC = ['sq_ft', 'bedrooms', 'bathrooms', 'monthly_charges_usd', 'sale_price_usd']
const DAY_MS = 86400000

export class UsageError extends Error {}

// Returns [y, m, d] for a real YYYY-MM-DD calendar date, or null.
function ymd(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null
  return [y, mo, d]
}

const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate()
const pad = (n, w = 2) => String(n).padStart(w, '0')
const dayNumber = (s) => { const [y, m, d] = ymd(s); return Date.UTC(y, m - 1, d) / DAY_MS }

// The exclusive lower bound of the window: run date minus 24 calendar months,
// with the day clamped to the end of that month (2028-02-29 -> 2026-02-28).
export function windowStart(runDate) {
  const [y, m, d] = ymd(runDate)
  const total = y * 12 + (m - 1) - WINDOW_MONTHS
  const [wy, wm] = [Math.floor(total / 12), (total % 12) + 1]
  return `${pad(wy, 4)}-${pad(wm)}-${pad(Math.min(d, daysInMonth(wy, wm)))}`
}

function number(name, value, { min, above, integer = false }) {
  const n = value === undefined || value.trim() === '' ? NaN : Number(value)
  if (!Number.isFinite(n)) throw new UsageError(`--${name} must be a number`)
  if (integer && !Number.isInteger(n)) throw new UsageError(`--${name} must be a whole number`)
  if (above !== undefined && !(n > above)) throw new UsageError(`--${name} must be greater than ${above}`)
  if (min !== undefined && !(n >= min)) throw new UsageError(`--${name} must be ${min} or more`)
  return n
}

export function parseCliArgs(argv) {
  const str = { type: 'string' }
  let values
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        'run-date': str, 'out-dir': str, in: str, limit: str,
        neighbourhood: str, type: str, sqft: str, beds: str, baths: str, monthly: str, building: str,
      },
      strict: true,
      allowPositionals: false,
    }))
  } catch (err) {
    throw new UsageError(err.message)
  }
  const required = ['run-date', 'out-dir', 'neighbourhood', 'type', 'sqft', 'beds', 'baths', 'monthly', 'building']
  const missing = required.filter((k) => values[k] === undefined || values[k].trim() === '')
  if (missing.length) throw new UsageError(`missing ${missing.map((k) => `--${k}`).join(', ')}`)
  if (!ymd(values['run-date'])) throw new UsageError('--run-date must be a real date as YYYY-MM-DD')
  return {
    runDate: values['run-date'],
    outDir: values['out-dir'],
    inFile: values.in ?? DEFAULT_IN,
    inLabel: values.in ?? DEFAULT_IN_LABEL,
    limit: values.limit === undefined ? DEFAULT_LIMIT : number('limit', values.limit, { min: 1, integer: true }),
    subject: {
      neighbourhood: values.neighbourhood,
      type: values.type,
      building: values.building,
      sqft: number('sqft', values.sqft, { above: 0 }),
      beds: number('beds', values.beds, { min: 0 }),
      baths: number('baths', values.baths, { min: 0 }),
      monthly: number('monthly', values.monthly, { above: 0 }),
    },
  }
}

// Parses the sales CSV. Lines starting with "#" are notes. Returns the good
// rows and every skipped row as { line, reason } (line is 1-based in the file).
// Throws if there is no header or it is not the expected 12 columns.
export function parseSales(text) {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''))
  if (lines.at(-1) === '') lines.pop()
  const rows = []
  const skipped = []
  let header = false
  lines.forEach((raw, i) => {
    const line = i + 1
    if (raw.startsWith('#')) return
    if (!header) {
      if (raw !== COLUMNS.join(',')) throw new Error(`line ${line}: header must be ${COLUMNS.join(',')}`)
      header = true
      return
    }
    if (raw.trim() === '') return skipped.push({ line, reason: 'empty row' })
    const cells = raw.split(',')
    if (cells.length !== COLUMNS.length) return skipped.push({ line, reason: `has ${cells.length} cells, expected ${COLUMNS.length}` })
    const blank = COLUMNS.filter((c, j) => cells[j].trim() === '')
    if (blank.length) return skipped.push({ line, reason: `blank ${blank.join(' and ')}` })
    const sale = Object.fromEntries(COLUMNS.map((c, j) => [c, cells[j].trim()]))
    const bad = NUMERIC.filter((c) => !Number.isFinite(Number(sale[c])) || Number(sale[c]) < 0)
    if (bad.length) return skipped.push({ line, reason: `not a number: ${bad.join(' and ')}` })
    if (Number(sale.sq_ft) === 0) return skipped.push({ line, reason: 'sq_ft is 0' })
    if (!ymd(sale.sale_date)) return skipped.push({ line, reason: `bad sale_date ${sale.sale_date}` })
    for (const c of NUMERIC) sale[c] = Number(sale[c])
    rows.push(sale)
  })
  if (!header) throw new Error(`no header line; expected ${COLUMNS.join(',')}`)
  return { rows, skipped }
}

export function filterRows(rows, { neighbourhood, type, runDate }) {
  const start = windowStart(runDate)
  return rows.filter((r) => r.neighbourhood === neighbourhood && r.type === type &&
    r.sale_date > start && r.sale_date <= runDate)
}

// "prewar elevator" -> { era: 'prewar', access: 'elevator' }; anything that is
// not two words -> null, which scores as a full building mismatch.
export function splitBuilding(building) {
  const parts = String(building).trim().toLowerCase().split(/\s+/)
  return parts.length === 2 ? { era: parts[0], access: parts[1] } : null
}

function buildingDiff(a, b) {
  const [x, y] = [splitBuilding(a), splitBuilding(b)]
  if (!x || !y) return 1
  if (x.era === y.era && x.access === y.access) return 0
  return x.era === y.era || x.access === y.access ? 0.5 : 1
}

const round2 = (n) => Math.round(n * 100) / 100
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

function moreOrLess(delta, unit, more, less) {
  return `${plural(Math.abs(delta), unit)} ${delta > 0 ? more : less}`
}

export function scoreRow(sale, subject, runDate) {
  const daysAgo = dayNumber(runDate) - dayNumber(sale.sale_date)
  const diff = {
    sqft: Math.abs(sale.sq_ft - subject.sqft) / subject.sqft,
    beds: Math.abs(sale.bedrooms - subject.beds) / 2,
    baths: Math.abs(sale.bathrooms - subject.baths) / 2,
    monthly: Math.abs(sale.monthly_charges_usd - subject.monthly) / subject.monthly,
    building: buildingDiff(sale.building, subject.building),
    recency: daysAgo / 730,
  }
  let penalty = 0
  for (const k of Object.keys(WEIGHTS)) penalty += WEIGHTS[k] * Math.min(1, diff[k])
  const score = round2(100 - penalty)

  const dSqft = sale.sq_ft - subject.sqft
  const dBeds = sale.bedrooms - subject.beds
  const dBaths = sale.bathrooms - subject.baths
  const dMonthly = sale.monthly_charges_usd - subject.monthly
  const reason = [
    diff.building === 0 ? 'same building type' : sale.building,
    dSqft === 0 ? 'same sq ft' : `${thousands(Math.abs(dSqft))} sq ft ${dSqft > 0 ? 'larger' : 'smaller'}`,
    dBeds === 0 ? 'same beds' : moreOrLess(dBeds, 'bed', 'more', 'fewer'),
    dBaths === 0 ? 'same baths' : moreOrLess(dBaths, 'bath', 'more', 'fewer'),
    dMonthly === 0 ? 'same monthly' : `$${thousands(Math.abs(dMonthly))} monthly ${dMonthly > 0 ? 'higher' : 'lower'}`,
    `${plural(daysAgo, 'day')} old`,
  ].join('; ')
  return { score, reason, ppsf: Math.round(sale.sale_price_usd / sale.sq_ft) }
}

// Best score first; ties go to the newer sale, then the lower sale_id.
export function rankComps(rows, subject, runDate, limit) {
  return rows
    .map((sale) => ({ sale, ...scoreRow(sale, subject, runDate) }))
    .sort((a, b) => b.score - a.score ||
      (a.sale.sale_date < b.sale.sale_date ? 1 : a.sale.sale_date > b.sale.sale_date ? -1 : 0) ||
      (a.sale.sale_id < b.sale.sale_id ? -1 : a.sale.sale_id > b.sale.sale_id ? 1 : 0))
    .slice(0, limit)
    .map((c, i) => ({ rank: i + 1, ...c }))
}

export function thousands(n) {
  const [whole, frac] = String(n).split('.')
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return frac === undefined ? grouped : `${grouped}.${frac}`
}

export const addressUnit = (sale) => `${sale.address}, ${sale.unit}`
const md = (s) => String(s).replace(/\|/g, '\\|')

export function renderReport({ runDate, subject, inputName, passCount, limit, comps, skipped }) {
  const out = [
    '# Comparable sales',
    '',
    `- Run date: ${runDate}`,
    `- Window: sale_date after ${windowStart(runDate)} and on or before ${runDate}`,
    `- Input: ${md(inputName)}`,
    `- Subject: ${md(subject.neighbourhood)}, ${md(subject.type)}, ${thousands(subject.sqft)} sq ft, ${subject.beds} bed, ${subject.baths} bath, $${thousands(subject.monthly)} monthly, ${md(subject.building)}`,
    '',
    '## Scoring weights',
    '',
    'Score = 100 minus, for each measure, weight × difference (difference capped at 1).',
    '',
    '| Measure | Weight | Difference |',
    '|---|---|---|',
    ...Object.keys(WEIGHTS).map((k) => `| ${k} | ${WEIGHTS[k]} | ${md(WEIGHT_NOTES[k])} |`),
    '',
    '## Result',
    '',
    `Rows passing filter: ${passCount}`,
    `Fewer than ${limit} rows passed: ${passCount < limit ? 'yes' : 'no'}`,
    `Comps listed: ${comps.length}`,
    '',
    '| Rank | Address and unit | Sale price | Price per sq ft | Sale date | Score | Reason |',
    '|---|---|---|---|---|---|---|',
    ...comps.map((c) => `| ${c.rank} | ${md(addressUnit(c.sale))} | $${thousands(c.sale.sale_price_usd)} | $${thousands(c.ppsf)} | ${c.sale.sale_date} | ${c.score.toFixed(2)} | ${md(c.reason)} |`),
    '',
    '## Skipped rows',
    '',
    `Skipped rows: ${skipped.length}`,
    '',
    ...(skipped.length ? skipped.map((s) => `- line ${s.line}: ${md(s.reason)}`) : ['none']),
  ]
  return out.join('\n') + '\n'
}

export const CSV_HEADER = 'rank,address,unit,sale_price_usd,price_per_sq_ft_usd,sale_date,score,reason'

const csvCell = (v) => {
  const s = String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function renderCsv(comps) {
  const lines = [CSV_HEADER, ...comps.map((c) => [
    c.rank, c.sale.address, c.sale.unit, c.sale.sale_price_usd, c.ppsf, c.sale.sale_date, c.score.toFixed(2), c.reason,
  ].map(csvCell).join(','))]
  return lines.join('\n') + '\n'
}

export function main(argv) {
  let opts
  try {
    opts = parseCliArgs(argv)
  } catch (err) {
    if (!(err instanceof UsageError)) throw err
    console.error(`find-comps: ${err.message}`)
    return 2
  }
  let parsed
  try {
    parsed = parseSales(readFileSync(opts.inFile, { encoding: 'utf8', flag: 'r' }))
  } catch (err) {
    console.error(`find-comps: cannot use ${opts.inLabel}: ${err.code ?? err.message}`)
    return 1
  }
  const { subject, runDate, limit } = opts
  const passed = filterRows(parsed.rows, { neighbourhood: subject.neighbourhood, type: subject.type, runDate })
  const comps = rankComps(passed, subject, runDate, limit)
  mkdirSync(opts.outDir, { recursive: true })
  writeFileSync(path.join(opts.outDir, 'report.md'), renderReport({
    runDate, subject, inputName: opts.inLabel, passCount: passed.length, limit, comps, skipped: parsed.skipped,
  }))
  writeFileSync(path.join(opts.outDir, 'comps.csv'), renderCsv(comps))
  console.log(`wrote ${path.join(opts.outDir, 'report.md')} and comps.csv (${comps.length} comps, ${passed.length} passed, ${parsed.skipped.length} skipped)`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2))
}
