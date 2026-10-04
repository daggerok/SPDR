#!/usr/bin/env bun
// Checked-in JSON (scripts/update-data.config.json) holds the defaults; see resolveControls() for precedence.
/// <reference types="bun" />
import { readFile as outputReadFile, readdir as outputReadDir } from 'node:fs/promises';
import { createHash as outputCreateHash } from 'node:crypto';
import { join as outputJoin } from 'node:path';
import { fileURLToPath as outputFileURLToPath } from 'node:url';

// Console presentation; no changes to provider requests or persisted data.
/** Presentation only: no requests, writes, filtering, or changes to updater state. */

const outputClean = (value: unknown): string => String(value ?? 'null').replace(/[\r\n\t]+/g, ' ');
/** Presentation only: per-fund retry and fallback notices are printed when VERBOSE is enabled. */
const outputVerbose = (): boolean => /^(1|true|yes|on)$/i.test((globalThis as any).process?.env?.VERBOSE ?? '');
function outputNote(message: string): void { if (outputVerbose()) console.warn(message); }
/** Names are the canonical environment knobs, not internal parser properties. */
function outputConfigEntries(config: Record<string, any>): [string, string][] {
  const values = new Map<string, string>();
  const aliases: Record<string, string> = {
    requestSleepSeconds: 'REQUEST_SLEEP', categories: 'CATEGORY',
    aumRange: 'AUM', terRange: 'TER', dividendYieldRange: 'DIVIDEND_YIELD', secYieldRange: 'SEC_YIELD',
    performanceRanges: 'PERFORMANCE', totalReturnRanges: 'TOTAL_RETURN',
    skipVanEck: 'SKIP_VANECK', skipProShares: 'SKIP_PROSHARES',
    skipWisdomTree: 'SKIP_WISDOMTREE', skipGoldmanSachs: 'SKIP_GOLDMANSACHS',
  };
  const range = (v: any): string => v?.source ?? `${Number.isFinite(v?.min) ? v.min : ''}:${Number.isFinite(v?.max) ? v.max : ''}`;
  for (const [key, value] of Object.entries(config)) {
    const name = aliases[key] ?? key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
    if (name === 'PERFORMANCE' || name === 'TOTAL_RETURN') {
      for (const period of ['YTD', '1Y', '3Y', '5Y', '10Y']) values.set(`${name}_${period}`, range(value?.[period]));
    } else if (['AUM', 'TER', 'DIVIDEND_YIELD', 'SEC_YIELD'].includes(name)) {
      values.set(name, range(value));
    } else {
      values.set(name, value instanceof Set ? [...value].join(',') || 'all' : Array.isArray(value) ? value.join(',') || 'all' : outputClean(value));
    }
  }
  const first = ['MAX_FETCHES', 'REQUEST_SLEEP', 'CONCURRENCY'];
  return [...values].sort(([a], [b]) => {
    const ai = first.indexOf(a), bi = first.indexOf(b);
    return (ai < 0 ? first.length : ai) - (bi < 0 ? first.length : bi) || a.localeCompare(b);
  });
}
function outputPrintConfig(brand: string, config: Record<string, any>): void {
  const entries: [string, string][] = [...outputConfigEntries(config), ['VERBOSE', String(outputVerbose())]];
  console.log(`[ config   ] ${brand} updater:\n${entries.map(([key, value]) => `              ${key}=${/TOKEN|PASSWORD|SECRET|COOKIE/i.test(key) ? '<redacted>' : outputClean(value)}`).join('\n')}`);
}
function outputHasOutputFilters(config: Record<string, any>): boolean {
  return outputConfigEntries(config).some(([name, value]) =>
    /^(TICKERS|CATEGORY|AUM|TER|DIVIDEND_YIELD|SEC_YIELD|PERFORMANCE_|TOTAL_RETURN_)/.test(name) &&
    !['', ':', 'null', 'all'].includes(value));
}
function outputPrintFilter(selected: number, total: number, deferred = false): void {
  console.log(`[ filter   ] ${selected} of ${total} funds ${deferred ? 'selected for evaluation (data-dependent filters applied per fund)' : 'pass filters'}`);
}
function outputStable(value: any): any {
  if (Array.isArray(value)) return value.map(outputStable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(key => !['generatedAt', 'catalogReadAt'].includes(key)).map(key => [key, outputStable(value[key])]));
  return value;
}
function outputContentKey(value: unknown): string { return JSON.stringify(outputStable(value)) ?? 'null'; }
async function outputInspectFund(root: URL | string, ticker: string): Promise<{ digest: string; meta: any }> {
  const dir = outputJoin(root instanceof URL ? outputFileURLToPath(root) : root, 'funds', ticker);
  const hash = outputCreateHash('sha256');
  async function visit(path: string): Promise<void> {
    const entries = await outputReadDir(path, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) await visit(outputJoin(path, entry.name));
      else if (entry.name.endsWith('.json')) {
        const text = await outputReadFile(outputJoin(path, entry.name), 'utf8').catch(() => '');
        hash.update(outputJoin(path.slice(dir.length), entry.name));
        try { hash.update(outputContentKey(JSON.parse(text))); } catch { hash.update(text); }
      }
    }
  }
  await visit(dir);
  const meta = await outputReadFile(outputJoin(dir, 'meta.json'), 'utf8').then(JSON.parse).catch(() => ({}));
  return { digest: hash.digest('hex'), meta };
}
const outputCount = (value: any): unknown => typeof value === 'number' ? value : Array.isArray(value) ? value.length : value?.totalRows ?? value?.rows?.length ?? null;
const outputScalar = (value: any): any => value && typeof value === 'object' ? value.display ?? value.value ?? null : value;
function outputMoney(value: any): string {
  const raw = outputScalar(value);
  if (raw === null || raw === undefined || raw === '—' || raw === '--') return 'null';
  const text = String(raw).replace(/[$,\s]/g, '');
  const match = text.match(/^([+-]?[\d.]+)([KMBT])?$/i);
  if (!match) return outputClean(raw);
  const number = Number(match[1]) * ({ K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[match[2]?.toUpperCase() as 'K' | 'M' | 'B' | 'T'] ?? 1);
  if (!Number.isFinite(number)) return 'null';
  for (const [unit, scale] of [['T', 1e12], ['B', 1e9], ['M', 1e6], ['K', 1e3]] as const) {
    if (Math.abs(number) >= scale) return `$${(number / scale).toFixed(1)}${unit}`;
  }
  return `$${number.toFixed(2)}`;
}
function outputFundLine(index: number, total: number, ticker: string, status: string, data: any = {}, reason?: unknown): string {
  const width = Math.max(2, String(total).length);
  const metrics = data.metrics ?? {};
  // Presentation only. Keep valid zero/false values; omit unavailable fields.
  // outputMoney returns the string 'null' for an unavailable monetary value.
  const field = (key: string, value: unknown): string =>
    value === null || value === undefined || value === 'null' ? '' : `${key}=${outputClean(value)}`;
  const sources = [
    field('official', data.officialHistoryCount),
    field('yahoo', data.yahooHistoryCount),
  ].filter(part => part !== '').join(' ');
  const detail = [
    field('port', data.portId ?? data.portfolioId),
    field('history', outputCount(data.history ?? data.historyCount)),
    sources ? `(${sources})` : '',
    field('holdings', outputCount(data.holdings ?? data.holdingsCount)),
    field('divs', outputCount(data.worksheets?.Distributions ?? data.distributions)),
    field('netAssets', outputMoney(data.netAssets ?? data.aum)),
    field('total', outputMoney(data.totalFundNetAssets ?? data.totalNetAssets)),
    field('div', outputScalar(data.trailingYield ?? data.yields?.effectiveYield ?? data.yields?.dividendYield ?? data.dividendYield ?? metrics.dividendYield)),
    field('sec', outputScalar(data.secYield ?? data.yields?.secYield ?? metrics.secYield)),
    field('wp', data.workplaceRaw),
  ].filter(part => part !== '').join(' ');
  return `[ ${String(index).padStart(width)}/${String(total).padEnd(width)}  ] ${outputClean(ticker).padEnd(5)} ${status.padEnd(9)}${detail ? ` ${detail}` : ''}${reason ? ` reason=${outputClean(reason)}` : ''}`;
}
function outputCreateReporter(root: URL | string, total: number) {
  let completed = 0;
  return {
    before: (ticker: string) => outputInspectFund(root, ticker),
    async result(ticker: string, before: { digest: string }, status?: string, reason?: unknown, extra: any = {}) {
      const after = await outputInspectFund(root, ticker);
      console.log(outputFundLine(++completed, total, ticker, status ?? (before.digest === after.digest ? 'unchanged' : 'updated'), { ...after.meta, ...extra }, reason));
    },
  };
}


// SPDR (State Street Global Advisors) static data updater.
// Fetches the public SPDR US ETF catalog, per-fund daily holdings XLSX,
// NAV history XLSX, daily Premium/Discount history XLSX, the latest dividend
// distribution, and the bulk product-data XLSX (ISIN/CUSIP/SEC yield/Fund
// Dividend Yield for the whole lineup), then writes a deterministic,
// paginated static JSON API under ./api/spdr, following the daggerok/iShares
// repository design (no dependencies, Bun only).

import { mkdir, readFile, writeFile, readdir, rm, appendFile, rename, access } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// Constants and small helpers
// ---------------------------------------------------------------------------

type JsonRecord = Record<string, any>;

const FUND_FINDER_URL =
  'https://www.ssga.com/bin/v1/ssmp/fund/fundfinder?country=us&language=en&role=intermediary&product=etfs&ui=fund-finder';
const DISTRIBUTIONS_URL =
  'https://www.ssga.com/bin/v1/ssmp/fund/dividend-distribution?country=us&language=en&role=intermediary&product=etfs';
const FUND_DATA_BASE = 'https://www.ssga.com/library-content/products/fund-data/etfs/us';
const PRODUCT_DATA_URL = `${FUND_DATA_BASE}/spdr-product-data-us-en.xlsx`;
const SSGA_SITE = 'https://www.ssga.com';

let API_ROOT = new URL('../api/spdr/', import.meta.url);
let INDEX_FILE = new URL('index.json', API_ROOT);
let STATE_FILE = new URL('update-state.json', API_ROOT);

/** Points the output tree somewhere else (tests only); `root` must end with a slash. */
export function setApiRoot(root: URL): void {
  API_ROOT = root;
  INDEX_FILE = new URL('index.json', root);
  STATE_FILE = new URL('update-state.json', root);
}

const HOLDINGS_PAGE_SIZE_FALLBACK = 250;
const HISTORY_PAGE_SIZE_FALLBACK = 1000;
const CONCURRENCY_FALLBACK = 2;
const REQUEST_SLEEP_FALLBACK = 1;
const MAX_RETRIES_FALLBACK = 2;
/** Per request (headers and body). A stalled connection is aborted and retried per MAX_RETRIES. */
let requestTimeoutMs = 45_000;
/** The run stops taking new funds after this and still writes the index (workflow timeout is 30 min). */
let softDeadlineMs = 25 * 60_000;
export function setRequestTimeoutMs(ms: number): void { requestTimeoutMs = ms; }
export function setSoftDeadlineMs(ms: number): void { softDeadlineMs = ms; }
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// SSGA encodes "not published" as a denormalized double (5e-324, Number.MIN_VALUE).
function isMissingNumber(value: unknown): boolean {
  return typeof value === 'number' && value !== 0 && Math.abs(value) < 1e-290;
}

function sanitizeTicker(raw: unknown): string {
  return String(raw ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

function cleanText(raw: unknown): string {
  return String(raw ?? '')
    .replace(/\u00ae/g, '') // ®
    .replace(/\u2122/g, '') // ™
    .replace(/\s+/g, ' ')
    .trim();
}

function textOrNull(raw: unknown): string | null {
  const text = cleanText(raw);
  return text === '' || text === '-' ? null : text;
}

// "2.97057744E8" -> "297057744"; keeps non-numeric text untouched.
export function normalizeNumberText(raw: unknown): string {
  const text = String(raw ?? '').trim();
  if (text === '' || text === '-') return text;
  if (!/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(text.replace(/,/g, ''))) return text;
  const number = Number(text.replace(/,/g, ''));
  if (!Number.isFinite(number) || Math.abs(number) >= 1e21) return text;
  return number.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 10 });
}

function pad3(value: number): string {
  return String(value).padStart(3, '0');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Updater configuration (environment variables, daggerok/iShares-style)
// ---------------------------------------------------------------------------

type Range = { min?: number; max?: number };
type ReturnPeriod = 'YTD' | '1Y' | '3Y' | '5Y' | '10Y';
const RETURN_PERIODS: readonly ReturnPeriod[] = ['YTD', '1Y', '3Y', '5Y', '10Y'];
type RangeMap = Partial<Record<ReturnPeriod, Range>>;

type UpdaterConfig = {
  concurrency: number;
  requestSleep: number;
  maxFetches: number;
  holdingsPageSize: number;
  historyPageSize: number;
  storeRawDownloads: boolean;
  maxRetries: number;
  tickers: string[];
  aumRange?: Range & { source?: string };
  terRange?: Range;
  dividendYieldRange?: Range;
  secYieldRange?: Range;
  historyRange: string;
  performanceRanges: RangeMap;
  totalReturnRanges: RangeMap;
};

const AUM_PRESET_BOUNDS = {
  nano: { min: 0, max: 10_000_000 },
  micro: { min: 10_000_000, max: 300_000_000 },
  small: { min: 300_000_000, max: 2_000_000_000 },
  mid: { min: 2_000_000_000, max: 10_000_000_000 },
  large: { min: 10_000_000_000, max: undefined },
} as const;
type AumPreset = keyof typeof AUM_PRESET_BOUNDS;

const AMOUNT_SUFFIXES: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };

function envValue(env: Record<string, string | undefined>, name: string): string {
  return (env[name] ?? '').trim();
}

/** Strict integer control: blank -> fallback, anything that is not an integer >= min is an error (never a silent fallback). */
function parseIntControl(raw: string, name: string, fallback: number, min = 1): number {
  if (raw === '') return fallback;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < min) throw new Error(`${name}: expected integer >= ${min}, got "${raw}"`);
  return Number(raw);
}

function parseBoolean(raw: string, name = 'boolean control'): boolean {
  if (raw === '') return false;
  if (/^(1|true|yes|y|on)$/i.test(raw)) return true;
  if (/^(0|false|no|n|off)$/i.test(raw)) return false;
  throw new Error(`${name}: expected boolean, got "${raw}"`);
}

function parseDecimal(raw: string): number {
  return Number(raw.replace(/_/g, ''));
}

/**
 * Strict `min:max` range parser (centralized, same contract as daggerok/iShares).
 * Both bounds are inclusive; empty input or `:` means "no restriction".
 */
export function parseRange(raw: string, label: string): Range | undefined {
  const text = String(raw ?? '').trim();
  if (text === '' || text === ':') return undefined;
  const parts = text.split(':');
  if (parts.length !== 2) {
    throw new Error(`${label}: "${text}" must contain exactly one colon (use ":" for no restriction)`);
  }
  const parse = (part: string): number | undefined => {
    const normalized = part.trim().replace(/%$/, '');
    if (normalized === '') return undefined;
    const value = parseDecimal(normalized);
    if (!Number.isFinite(value)) throw new Error(`${label}: "${part.trim()}" is not a number`);
    return value;
  };
  const range = { min: parse(parts[0]), max: parse(parts[1]) };
  if (range.min !== undefined && range.max !== undefined && range.min > range.max) {
    throw new Error(`${label}: minimum ${range.min} exceeds maximum ${range.max}`);
  }
  return range;
}

function parseAmountBound(part: string): number | undefined {
  const normalized = part.trim().replace(/[$\s]/g, '');
  if (normalized === '') return undefined;
  const suffix = normalized.slice(-1).toUpperCase();
  const multiplier = AMOUNT_SUFFIXES[suffix];
  const numeric = multiplier ? normalized.slice(0, -1) : normalized;
  if (!/^\d+(\.\d+)?$/.test(numeric)) return undefined;
  const value = parseDecimal(numeric);
  return Number.isFinite(value) ? value * (multiplier ?? 1) : undefined;
}

/** AUM range parser: each bound is a USD amount (optionally K/M/B/T) or an AUM preset. */
export type AumRange = Range & { source: string; maxExclusive?: boolean };
export function parseAumRange(raw: string): AumRange | undefined {
  const text = String(raw ?? '').trim();
  if (text === '' || text === ':') return undefined;
  const parts = text.split(':');
  if (parts.length !== 2) {
    throw new Error(`AUM: "${text}" must contain exactly one colon (use ":" for no restriction)`);
  }
  type Bound = { min?: number; max?: number; maxExclusive?: boolean };
  const resolvePreset = (part: string): Bound | null => {
    const normalized = part.trim().toLowerCase();
    if (normalized in AUM_PRESET_BOUNDS) {
      const preset = AUM_PRESET_BOUNDS[normalized as AumPreset];
      return { min: preset.min, max: preset.max, maxExclusive: preset.max !== undefined };
    }
    return null;
  };
  const resolveAmount = (part: string): Bound => {
    if (part.trim() === '') return {};
    const amount = parseAmountBound(part);
    if (amount === undefined) throw new Error(`AUM: "${part.trim()}" is not an amount or preset`);
    return { min: amount, max: amount };
  };
  const left = resolvePreset(parts[0]) ?? resolveAmount(parts[0]);
  const right = resolvePreset(parts[1]) ?? resolveAmount(parts[1]);
  const range: AumRange = { source: text };
  range.min = left.min;
  if (left.maxExclusive) {
    range.max = left.max;
    range.maxExclusive = true;
  }
  if (right.maxExclusive) {
    range.max = right.max;
    range.maxExclusive = true;
  } else if (right.max !== undefined) {
    range.max = right.max;
    range.maxExclusive = false;
  }
  if (range.min !== undefined && range.max !== undefined && range.min > range.max) {
    throw new Error(`AUM: minimum ${range.min} exceeds maximum ${range.max}`);
  }
  return range;
}

function matchesRange(value: number | null | undefined, range?: Range, maxExclusive = false): boolean {
  if (!range) return true;
  if (value === null || value === undefined || !Number.isFinite(value)) return false;
  if (range.min !== undefined && value < range.min) return false;
  if (range.max !== undefined) {
    if (maxExclusive && value >= range.max) return false;
    if (!maxExclusive && value > range.max) return false;
  }
  return true;
}

/** HISTORY_RANGE: "max" (default) or a window like "5y" / "18mo" counted back from the newest row. */
export function normalizeHistoryRange(raw: string): string {
  const text = String(raw ?? '').trim().toLowerCase();
  if (text === '' || text === 'max') return 'max';
  if (/^[1-9]\d*(y|mo)$/.test(text)) return text;
  throw new Error(`HISTORY_RANGE: "${raw}" must be max, Ny or Nmo (for example 5y or 18mo)`);
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function historyDate(text: string): number | null {
  const match = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(text.trim());
  const month = match ? MONTHS.indexOf(match[2].toLowerCase()) : -1;
  return match && month >= 0 ? Date.UTC(Number(match[3]), month, Number(match[1])) : null;
}

/** Keeps only rows inside the HISTORY_RANGE window ending at the newest dated row; undated rows are kept. */
export function applyHistoryRange(table: SheetTable, range: string): SheetTable {
  const match = /^(\d+)(y|mo)$/.exec(range);
  if (!match) return table;
  const dateIndex = table.headers.findIndex((header) => header.toLowerCase() === 'date');
  if (dateIndex < 0) return table;
  const dates = table.rows.map((row) => historyDate(row[dateIndex] ?? ''));
  const newest = Math.max(...dates.filter((date): date is number => date !== null));
  if (!Number.isFinite(newest)) return table;
  const start = new Date(newest);
  start.setUTCMonth(start.getUTCMonth() - Number(match[1]) * (match[2] === 'y' ? 12 : 1));
  return { headers: table.headers, rows: table.rows.filter((_, index) => dates[index] === null || dates[index]! >= start.getTime()) };
}

export function loadConfig(env: Record<string, string | undefined>): UpdaterConfig {
  const performanceRanges: RangeMap = {};
  const totalReturnRanges: RangeMap = {};
  for (const period of RETURN_PERIODS) {
    const performance = parseRange(envValue(env, `PERFORMANCE_${period}`), `PERFORMANCE_${period}`);
    if (performance) performanceRanges[period] = performance;
    const totalReturn = parseRange(envValue(env, `TOTAL_RETURN_${period}`), `TOTAL_RETURN_${period}`);
    if (totalReturn) totalReturnRanges[period] = totalReturn;
  }
  return {
    concurrency: parseIntControl(envValue(env, 'CONCURRENCY'), 'CONCURRENCY', CONCURRENCY_FALLBACK),
    requestSleep: (() => {
      const raw = envValue(env, 'REQUEST_SLEEP');
      if (raw === '') return REQUEST_SLEEP_FALLBACK;
      const value = parseDecimal(raw);
      if (!Number.isFinite(value) || value < 0) throw new Error(`REQUEST_SLEEP: expected nonnegative seconds, got "${raw}"`);
      return value;
    })(),
    maxFetches: parseIntControl(envValue(env, 'MAX_FETCHES'), 'MAX_FETCHES', 0, 0),
    holdingsPageSize: parseIntControl(envValue(env, 'HOLDINGS_PAGE_SIZE'), 'HOLDINGS_PAGE_SIZE', HOLDINGS_PAGE_SIZE_FALLBACK),
    historyPageSize: parseIntControl(envValue(env, 'HISTORY_PAGE_SIZE'), 'HISTORY_PAGE_SIZE', HISTORY_PAGE_SIZE_FALLBACK),
    storeRawDownloads: parseBoolean(envValue(env, 'STORE_RAW_DOWNLOADS'), 'STORE_RAW_DOWNLOADS'),
    maxRetries: parseIntControl(envValue(env, 'MAX_RETRIES'), 'MAX_RETRIES', MAX_RETRIES_FALLBACK),
    tickers: envValue(env, 'TICKERS')
      .split(/[\s,;]+/)
      .map(sanitizeTicker)
      .filter(Boolean),
    aumRange: parseAumRange(envValue(env, 'AUM')),
    terRange: parseRange(envValue(env, 'TER'), 'TER'),
    dividendYieldRange: parseRange(envValue(env, 'DIVIDEND_YIELD'), 'DIVIDEND_YIELD'),
    secYieldRange: parseRange(envValue(env, 'SEC_YIELD'), 'SEC_YIELD'),
    historyRange: normalizeHistoryRange(envValue(env, 'HISTORY_RANGE')),
    performanceRanges,
    totalReturnRanges,
  };
}

function printHelp(): void {
  const lines = [
    'SPDR static data updater (Bun, zero dependencies)',
    '',
    'Writes a paginated static API under ./api/spdr from public SSGA feeds:',
    '  - ETF catalog:     ssga.com fund finder (SPDR US ETFs)',
    '  - Daily holdings:  holdings-daily-us-en-{ticker}.xlsx',
    '  - NAV history:     navhist-us-en-{ticker}.xlsx',
    '  - Premium/Discount history: pdhist-us-en-{ticker}.xlsx',
    '  - Product data:    spdr-product-data-us-en.xlsx (ISIN/CUSIP/SEC yield/',
    '                      Fund Dividend Yield, whole lineup, fetched once)',
    '  - Distributions:   latest dividend distribution per fund',
    '',
    'Defaults live in scripts/update-data.config.json; the environment overrides them',
    '(the Update SPDR ETF data workflow adds `advanced` JSON and dispatch inputs in between).',
    'Environment variables (all optional; AND logic when combined):',
    '  TICKERS             Space/comma/semicolon ticker allowlist, e.g. "SPY XLK".',
    '  AUM                 min:max range; bounds are USD amounts (K/M/B/T suffixes',
    '                      allowed) or nano/micro/small/mid/large presets.',
    '  TER                 min:max inclusive NET expense-ratio range in %.',
    '  DIVIDEND_YIELD      min:max dividend yield range in % (official Fund Dividend',
    '                      Yield, else indicated from the latest distribution).',
    '  SEC_YIELD           min:max official 30-day SEC yield range in %.',
    '  PERFORMANCE_YTD     Month-end NAV return ranges in %; 3Y/5Y/10Y are CAGR.',
    '  PERFORMANCE_1Y      Colon required: "5:", ":20", "5:20"; ":" = no limit.',
    '  PERFORMANCE_3Y',
    '  PERFORMANCE_5Y',
    '  PERFORMANCE_10Y',
    '  TOTAL_RETURN_YTD    Quarter-end NAV return ranges in % (SSGA publishes a',
    '  TOTAL_RETURN_1Y     separate quarter-end series; same strict range syntax).',
    '  TOTAL_RETURN_3Y',
    '  TOTAL_RETURN_5Y',
    '  TOTAL_RETURN_10Y',
    '  CONCURRENCY         Parallel fund workers (default 2; SSGA rate-limits hard).',
    '  REQUEST_SLEEP       Minimum seconds between request starts (default 1).',
    '  MAX_FETCHES         Batch size; continues after the saved cursor. 0 = all.',
    '  HOLDINGS_PAGE_SIZE  Rows per generated holdings page (default 250).',
    '  HISTORY_PAGE_SIZE   Rows per generated NAV history page (default 1000).',
    '  STORE_RAW_DOWNLOADS Keep the latest source XLSX under api/spdr/raw (off).',
    '  HISTORY_RANGE       NAV and premium/discount history window: max (default),',
    '                      Ny or Nmo counted back from the newest row, e.g. 5y.',
    '  MAX_RETRIES         Retries after the first attempt, integer >= 1 (default 2).',
    '  VERBOSE             Print per-fund retry and fallback notices (off).',
    '  USE_SYSTEM_CA       TLS trust store: auto (default) restarts once with --use-system-ca on an',
    '                      untrusted-certificate error, true always uses the system CA, false never.',
    '',
    'Examples:',
    '  TICKERS="SPY XLK" ./scripts/update-data.ts',
    '  AUM="large:" TER=":0.1" ./scripts/update-data.ts',
    '  PERFORMANCE_3Y="5:20" MAX_FETCHES=20 ./scripts/update-data.ts',
  ];
  console.log(lines.join('\n'));
}

// ---------------------------------------------------------------------------
// HTTP with polite pacing, retries and 403 back-off
// ---------------------------------------------------------------------------

// One pacing lane per concurrent worker (sized from config.concurrency in
// main()). A single shared gate capped total throughput at one request per
// REQUEST_SLEEP no matter how high CONCURRENCY was set; CONCURRENCY workers
// now each get their own paced lane, so concurrency actually multiplies
// throughput as documented instead of only overlapping wait time.
let lastRequestAtLanes: number[] = [0];
let requestSleepSeconds = REQUEST_SLEEP_FALLBACK;
let maxRetriesConfig = MAX_RETRIES_FALLBACK;

/** Test hook: sets the per-lane gap (seconds) and the number of lanes. */
export function configurePacing(sleepSeconds: number, lanes: number, retries = maxRetriesConfig): void {
  requestSleepSeconds = sleepSeconds;
  lastRequestAtLanes = new Array(Math.max(1, lanes)).fill(0);
  maxRetriesConfig = retries;
}

/**
 * Picks the lane that frees up first and RESERVES its next slot synchronously,
 * before awaiting anything: callers entering together get distinct, spaced
 * slots instead of all choosing the same stale lane and bursting.
 */
export async function paceRequests(): Promise<void> {
  const gap = requestSleepSeconds * 1000;
  let lane = 0;
  for (let i = 1; i < lastRequestAtLanes.length; i++) if (lastRequestAtLanes[i] < lastRequestAtLanes[lane]) lane = i;
  const now = Date.now();
  const start = Math.max(now, lastRequestAtLanes[lane] + gap);
  lastRequestAtLanes[lane] = start;
  if (start > now) await sleep(start - now);
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export async function fetchWithRetry(url: string, label: string): Promise<Response> {
  let attempt = 0;
  for (;;) {
    await paceRequests();
    try {
      const raw = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
        redirect: 'follow',
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      // Buffer the body inside the retry loop so the timeout and retries cover the body too.
      const response = new Response([204, 205, 304].includes(raw.status) ? null : await raw.arrayBuffer(), { status: raw.status, statusText: raw.statusText });
      // SSGA front doors (Akamai) answer 403 while rate-limited; patience recovers.
      if (response.status === 403) {
        await response.arrayBuffer().catch(() => undefined);
        if (attempt >= maxRetriesConfig) throw new Error(`403 rate limited after ${attempt + 1} attempts: ${label}`);
        const waitSeconds = 15 * (attempt + 1);
        outputNote(
          `[ ${'retry'.padEnd(9)}] ${label} status=403 attempt=${attempt + 1}/${maxRetriesConfig + 1} waiting=${waitSeconds}s`,
        );
        await sleep(waitSeconds * 1000);
        attempt += 1;
        continue;
      }
      if (response.ok) return response;
      if (RETRYABLE_STATUS.has(response.status) && attempt < maxRetriesConfig) {
        const waitSeconds = Math.min(30, 2 ** attempt * 3);
        outputNote(
          `[ ${'retry'.padEnd(9)}] ${label} status=${response.status} attempt=${attempt + 1}/${maxRetriesConfig + 1} waiting=${waitSeconds}s`,
        );
        await sleep(waitSeconds * 1000);
        attempt += 1;
        continue;
      }
      return response;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('403 rate limited')) throw error;
      if (attempt >= maxRetriesConfig) throw error;
      const waitSeconds = Math.min(30, 2 ** attempt * 3);
      outputNote(
        `[ ${'retry'.padEnd(9)}] ${label} error=${(error as Error).message} attempt=${attempt + 1}/${maxRetriesConfig + 1} waiting=${waitSeconds}s`,
      );
      await sleep(waitSeconds * 1000);
      attempt += 1;
    }
  }
}

// ---------------------------------------------------------------------------
// Minimal ZIP reader + XLSX (OOXML SpreadsheetML) parser, node:zlib only
// ---------------------------------------------------------------------------

function findEndOfCentralDirectory(bytes: Uint8Array): { offset: number; entries: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minOffset = Math.max(0, bytes.length - 66_000);
  for (let i = bytes.length - 22; i >= minOffset; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      return { offset: i, entries: view.getUint16(i + 10, true) };
    }
  }
  throw new Error('ZIP: end of central directory not found');
}

export function readZipEntries(bytes: Uint8Array): Map<string, Uint8Array> {
  const eocd = findEndOfCentralDirectory(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = new Map<string, Uint8Array>();
  let offset = view.getUint32(eocd.offset + 16, true); // central directory offset
  for (let index = 0; index < eocd.entries; index += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error(`ZIP: bad central directory entry at ${offset}`);
    }
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = bytes.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) {
      entries.set(name, data);
    } else if (method === 8) {
      entries.set(name, new Uint8Array(inflateRawSync(Buffer.from(data))));
    } else {
      throw new Error(`ZIP: unsupported compression method ${method} for ${name}`);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&');
}

function xmlText(xml: string): string {
  return decodeXml(xml.replace(/<!\[CDATA\[([\s\S]*?)]]>/g, '$1'));
}

function parseSharedStrings(xml: string): string[] {
  const strings: string[] = [];
  const items = xml.match(/<si[\s>][\s\S]*?<\/si>|<si\/>/g) || [];
  for (const item of items) {
    const parts = item.match(/<t[^>]*>[\s\S]*?<\/t>/g) || [];
    strings.push(
      xmlText(parts.map((part) => part.replace(/^<t[^>]*>/, '').replace(/<\/t>$/, '')).join('')),
    );
  }
  return strings;
}

/** Column letters to zero-based index ("C7" -> 2). */
function columnIndex(reference: string): number {
  const letters = reference.replace(/\d+/g, '');
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

/** Parses the first worksheet of an XLSX file into rows of raw cell strings. */
export function parseXlsxSheet(bytes: Uint8Array, sharedStrings: string[]): string[][] {
  const entries = readZipEntries(bytes);
  const names = [...entries.keys()];
  const sheetName =
    names.find((name) => /^xl\/worksheets\/sheet1\.xml$/.test(name)) ||
    names.find((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)) ||
    names.find((name) => /^xl\/worksheets\/.+\.xml$/.test(name));
  if (!sheetName) throw new Error('XLSX: worksheet not found');
  const xml = new TextDecoder().decode(entries.get(sheetName)!);
  const rows: string[][] = [];
  const rowMatches = xml.match(/<row[\s>][\s\S]*?<\/row>|<row\/>/g) || [];
  for (const rowXml of rowMatches) {
    const cells: string[] = [];
    const cellMatches = rowXml.match(/<c[^>]*\/>|<c[^>]*>[\s\S]*?<\/c>/g) || [];
    for (const cellXml of cellMatches) {
      const reference = /r="([A-Z]+\d+)"/.exec(cellXml)?.[1] || '';
      const target = reference ? columnIndex(reference) : cells.length;
      const type = /t="([^"]+)"/.exec(cellXml)?.[1] || 'n';
      const value = /<v[^>]*>([\s\S]*?)<\/v>/.exec(cellXml)?.[1];
      const inlineMatches = cellXml.match(/<is>[\s\S]*?<\/is>/g) || [];
      let text = '';
      if (value !== undefined) {
        text = type === 's' ? (sharedStrings[Number(value)] ?? '') : xmlText(value);
      } else if (inlineMatches.length) {
        const inline = inlineMatches[0] ?? '';
        const parts = inline.match(/<t[^>]*>[\s\S]*?<\/t>/g) || [];
        text = xmlText(parts.map((part) => part.replace(/^<t[^>]*>/, '').replace(/<\/t>$/, '')).join(''));
      }
      while (cells.length < target) cells.push('');
      cells[target] = text.trim();
    }
    rows.push(cells);
  }
  return rows;
}

export function loadSharedStrings(bytes: Uint8Array): string[] {
  const xml = readZipEntries(bytes).get('xl/sharedStrings.xml');
  if (!xml) return [];
  return parseSharedStrings(new TextDecoder().decode(xml));
}

export type SheetTable = { headers: string[]; rows: string[][] };

/**
 * Converts raw worksheet rows into a {meta, table} pair. The SPDR workbooks
 * start with 2-3 metadata rows (Fund Name, Ticker Symbol, holdings as-of)
 * followed by the real header row: the first row with 4+ non-empty cells that
 * contains "Name"+"Weight" (holdings) or "Date"+"NAV" (NAV history).
 */
export function sheetToTable(
  rawRows: string[][],
  kind: 'holdings' | 'history' | 'premium-discount',
): { meta: JsonRecord; table: SheetTable } {
  const meta: JsonRecord = {};
  let headerIndex = rawRows.findIndex((row) => {
    const filled = row.filter((cell) => cell !== '').length;
    if (kind === 'premium-discount') {
      // pdhist workbooks only have a 2-column header (Date, Premium/Discount).
      const flat = row.map((cell) => cell.toLowerCase());
      return filled >= 2 && flat.includes('date') && flat.includes('premium/discount');
    }
    if (filled < 4) return false;
    const flat = row.map((cell) => cell.toLowerCase());
    if (kind === 'holdings') return flat.includes('name') && flat.includes('weight');
    return flat.includes('date') && flat.includes('nav');
  });
  if (headerIndex === -1) headerIndex = Math.min(3, Math.max(0, rawRows.length - 1));
  for (let i = 0; i < headerIndex; i += 1) {
    const row = rawRows[i];
    const first = cleanText(row[0] ?? '');
    if (/^fund name/i.test(first)) meta.fundName = cleanText(row[1] ?? '');
    else if (/^ticker/i.test(first)) meta.ticker = sanitizeTicker(row[1]);
    else if (/^(holdings|as of)/i.test(first)) meta.asOfDate = cleanText(row[row.length - 1]).replace(/^as of\s*/i, '');
  }
  const headerRow = rawRows[headerIndex] || [];
  let width = headerRow.length;
  while (width > 0 && cleanText(headerRow[width - 1]) === '') width -= 1;
  const headers = headerRow.slice(0, width).map((cell) => cleanText(cell));
  const rows: string[][] = [];
  for (let i = headerIndex + 1; i < rawRows.length; i += 1) {
    const row = rawRows[i];
    const cells = row.slice(0, width);
    // Every holding/history row has at least two populated cells; this drops the
    // trailing legal disclaimer row (one long cell) and blank separator rows.
    if (!row || cells.filter((cell) => cell !== '').length < 2) continue;
    rows.push(cells.map((cell) => normalizeNumberText(cell)));
  }
  return { meta, table: { headers, rows } };
}

// ---------------------------------------------------------------------------
// Bulk product-data workbook (official ISIN/CUSIP/SEC yield/dividend yield)
// ---------------------------------------------------------------------------

export type ProductDataRow = {
  isin: string | null;
  cusip: string | null;
  grossExpenseRatio: { display: string | null; value: number | null };
  netExpenseRatio: { display: string | null; value: number | null };
  secYield: { display: string | null; value: number | null };
  secYieldUnsubsidized: { display: string | null; value: number | null };
  fundDividendYield: { display: string | null; value: number | null };
  indexDividendYield: { display: string | null; value: number | null };
};

const PRODUCT_DATA_PERIOD_LABELS = /^(1 month|qtd|1 year|3 year|5 year|10 year|since inception)$/i;

/**
 * Parses `spdr-product-data-us-en.xlsx` (one row per SPDR ETF, whole lineup
 * in a single file) into a per-ticker lookup. This is the official SSGA
 * source for fields the fund finder/holdings/navhist feeds do not carry:
 * ISIN, CUSIP, Net Expense Ratio (fee waivers), 30-Day SEC Yield (subsidized
 * and unsubsidized) and Fund Dividend Yield.
 *
 * Its "Total Returns" block was checked against the fund finder feed: the
 * "(Cumulative)" columns stop at YTD and the "(Annualized)" 1Y/3Y/5Y/10Y/SI
 * columns are numerically identical to fund finder's yr1/yr3/yr5/yr10/
 * sinceInception. So this workbook carries no independent *cumulative*
 * multi-year total return that fund finder doesn't already have, and those
 * columns are intentionally not consumed here (see deriveCatalogMetrics for
 * the derived TR nY fallback that remains necessary for those tenors).
 */
export function parseProductDataSheet(bytes: Uint8Array): Map<string, ProductDataRow> {
  const rows = parseXlsxSheet(bytes, loadSharedStrings(bytes));
  const headerIndex = rows.findIndex((row) => {
    const flat = row.map((cell) => cell.toLowerCase());
    return flat.includes('ticker') && flat.includes('isin');
  });
  if (headerIndex === -1) throw new Error('product data: header row not found');
  // Some labels carry a footnote marker, e.g. "* Net Expense Ratio".
  const headers = rows[headerIndex].map((cell) => cleanText(cell).replace(/^\*+\s*/, ''));
  const columnIndex = (name: string): number =>
    headers.findIndex((header) => header.toLowerCase() === name.toLowerCase());
  const tickerIdx = columnIndex('Ticker');
  const isinIdx = columnIndex('ISIN');
  const cusipIdx = columnIndex('CUSIP');
  const netTerIdx = columnIndex('Net Expense Ratio');
  const grossTerIdx = columnIndex('Gross Expense Ratio');
  const secYieldIdx = columnIndex('30 Day SEC Yield');
  const secYieldUnsubIdx = columnIndex('30 Day SEC Yield (Unsubsidized)');
  const fundDivYieldIdx = columnIndex('Fund Dividend Yield');
  const indexDivYieldIdx = columnIndex('Index Dividend Yield');
  if (tickerIdx === -1) throw new Error('product data: Ticker column not found');

  // The "Total Returns" header spans a merged block whose period labels
  // ("1 Month", "QTD", ...) live in the row right below the header row; skip
  // it so it isn't mistaken for a data row.
  let dataStart = headerIndex + 1;
  const next = rows[dataStart] || [];
  if (next.some((cell) => PRODUCT_DATA_PERIOD_LABELS.test(cleanText(cell)))) dataStart += 1;

  const map = new Map<string, ProductDataRow>();
  for (let i = dataStart; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row || row.filter((cell) => cell !== '').length < 2) continue;
    const ticker = sanitizeTicker(row[tickerIdx]);
    if (!ticker) continue;
    map.set(ticker, {
      isin: textOrNull(row[isinIdx]),
      cusip: textOrNull(row[cusipIdx]),
      grossExpenseRatio: pairValue(row[grossTerIdx]),
      netExpenseRatio: pairValue(row[netTerIdx]),
      secYield: pairValue(row[secYieldIdx]),
      secYieldUnsubsidized: pairValue(row[secYieldUnsubIdx]),
      fundDividendYield: pairValue(row[fundDivYieldIdx]),
      indexDividendYield: pairValue(row[indexDivYieldIdx]),
    });
  }
  return map;
}

// ---------------------------------------------------------------------------
// Catalog normalization
// ---------------------------------------------------------------------------

type CatalogFund = {
  ticker: string;
  name: string;
  fundPage: string;
  category: string;
  ter: string | null;
  terValue: number | null;
  nav: string | null;
  navValue: number | null;
  aum: string | null;
  aumValue: number | null;
  asOfDate: string | null;
  inceptionDate: string | null;
  exchange: string | null;
  closePrice: string | null;
  closePriceValue: number | null;
  premiumDiscount: string | null;
  premiumDiscountValue: number | null;
  monthEnd: JsonRecord;
  quarterEnd: JsonRecord;
  factsheetUrl: string | null;
};

// ---------------------------------------------------------------------------
// Catalog metric derivations (Amplify/iShares column parity)
//
// SSGA's fund finder publishes *annualized* multi-year returns ("Annualized"
// per its own label metadata) plus cumulative YTD. daggerok/Amplify and
// daggerok/iShares show both cumulative total returns (TR nY) and annualized
// CAGRs, so CAGR comes straight from SSGA's yrN figures. SSGA's bulk
// spdr-product-data-us-en.xlsx was checked and does not add an independent
// cumulative figure for these tenors either (its "(Annualized)" columns are
// identical to fund finder's yrN CAGRs), so TR nY remains **derived**:
// (1 + cagr)^n - 1 (the exact inverse of annualizing a cumulative return).
//
// SSGA *does* publish a 30-day SEC yield (subsidized and unsubsidized) and an
// official "Fund Dividend Yield" for SPDR ETFs, in spdr-product-data-us-en.xlsx
// (parseProductDataSheet). Both are used directly when present. Dividend
// Yield only falls back to an *indicated* yield (latest distribution x
// payments per year / NAV) for the rare fund missing from that bulk file.
// ---------------------------------------------------------------------------

const DISTRIBUTIONS_PER_YEAR: Record<string, number> = {
  monthly: 12,
  quarterly: 4,
  'semi-annually': 2,
  semi: 2,
  annually: 1,
};

export function annualizedToTotal(annualizedPercent: number | null | undefined, years: number): number | null {
  if (typeof annualizedPercent !== 'number' || !Number.isFinite(annualizedPercent) || years <= 0) return null;
  if (annualizedPercent <= -100) return -100; // total loss floor for extreme annualized figures
  const total = (Math.pow(1 + annualizedPercent / 100, years) - 1) * 100;
  return Number.isFinite(total) ? Math.round(total * 100) / 100 : null;
}

export function indicatedYield(
  distribution: { frequency?: string | null; dividend?: string | null } | null | undefined,
  navValue: number | null | undefined,
): number | null {
  if (!distribution || !distribution.frequency || !distribution.dividend) return null;
  const perYear = DISTRIBUTIONS_PER_YEAR[String(distribution.frequency).trim().toLowerCase()];
  if (!perYear) return null;
  const dividend = Number(String(distribution.dividend).replace(/[^0-9.\-]/g, ''));
  if (!Number.isFinite(dividend) || dividend <= 0) return null;
  if (typeof navValue !== 'number' || !Number.isFinite(navValue) || navValue <= 0) return null;
  return Math.round(((dividend * perYear) / navValue) * 100 * 10000) / 10000;
}

function percentText(value: number | null): string | null {
  return value === null ? null : `${value.toFixed(2)}%`;
}

export const RETURNS_BASIS =
  'official SSGA month-end NAV total returns (YTD, 1Y, annualized 3Y/5Y/10Y and since inception); ' +
  'tr3y/tr5y/tr10y are derived from the official annualized figures as (1 + CAGR)^n - 1; no Yahoo or market-price estimates';

/** Converts SSGA dates ("Aug 31 2026", "08/31/2026", "2026-08-31") to ISO YYYY-MM-DD; null when unknown or invalid. */
export function toIsoDate(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  let year: number, month: number, day: number;
  let match: RegExpMatchArray | null;
  if ((match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/))) [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else if ((match = text.match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/))) [year, month, day] = [Number(match[3]), MONTHS.indexOf(match[1].toLowerCase()) + 1, Number(match[2])];
  else if ((match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) [year, month, day] = [Number(match[3]), Number(match[1]), Number(match[2])];
  else return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (month < 1 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

export type DividendYieldBasis = 'official-other' | 'indicated';

/** Code for the definition behind `dividendYield`; null exactly when the yield is null. */
export function dividendYieldBasisFor(source: unknown, dividendYield: unknown): DividendYieldBasis | null {
  if (typeof dividendYield !== 'number' || !Number.isFinite(dividendYield)) return null;
  switch (source) {
    // SSGA "Fund Dividend Yield" from the bulk product-data workbook: published, definition not stated there
    case 'official': return 'official-other';
    case 'indicated': return 'indicated';
    default: return 'indicated';
  }
}

/** Gives a metrics object read from older output the dividendYieldBasis key (derived from the yield it carries). */
export function withYieldBasis(metrics: unknown): JsonRecord {
  const m = (metrics && typeof metrics === 'object' ? metrics : {}) as JsonRecord;
  const code = dividendYieldBasisFor(m.dividendYieldSource, m.dividendYield);
  const out: JsonRecord = {};
  for (const [key, value] of Object.entries(m)) {
    if (key === 'dividendYieldBasis') continue;
    out[key] = value;
    if (key === 'dividendYieldSource') out.dividendYieldBasis = code;
  }
  if (!('dividendYieldBasis' in out)) out.dividendYieldBasis = code;
  return out;
}

export function deriveCatalogMetrics(
  monthEnd: JsonRecord,
  navValue: number | null,
  distribution: { frequency?: string | null; exDate?: string | null; dividend?: string | null } | null | undefined,
  productData?: ProductDataRow | null,
): JsonRecord {
  const numberOrNull = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  const cagr1 = numberOrNull(monthEnd.yr1);
  const cagr3 = numberOrNull(monthEnd.yr3);
  const cagr5 = numberOrNull(monthEnd.yr5);
  const cagr10 = numberOrNull(monthEnd.yr10);
  // Since-inception annualized only for funds with >= 1 year of history at the performance date.
  const inception = toIsoDate(monthEnd.inceptionDate);
  const performanceDate = toIsoDate(monthEnd.asOfDate);
  const underOneYear = (() => {
    if (!inception || !performanceDate) return false; // unknown dates: keep the published figure
    const limit = new Date(`${inception}T00:00:00Z`);
    limit.setUTCFullYear(limit.getUTCFullYear() + 1);
    return limit.toISOString().slice(0, 10) > performanceDate;
  })();
  const siAnn = underOneYear ? null : numberOrNull(monthEnd.sinceInception);
  const indicatedDividendYield = indicatedYield(distribution, navValue);
  const officialDividendYield = productData?.fundDividendYield?.value ?? null;
  const dividendYieldIsOfficial = officialDividendYield !== null;
  const dividendYield = dividendYieldIsOfficial ? officialDividendYield : indicatedDividendYield;
  const secYield = productData?.secYield?.value ?? null;
  const secYieldUnsubsidized = productData?.secYieldUnsubsidized?.value ?? null;
  const metrics: JsonRecord = {
    ytd: numberOrNull(monthEnd.ytd),
    // Cumulative total returns (TR nY). SSGA's 1Y annualized equals the 1Y total.
    // TR 3Y/5Y/10Y are **derived** — no official cumulative figure for these
    // tenors exists in any published SSGA feed (see the comment block above).
    tr1y: cagr1,
    tr3y: annualizedToTotal(cagr3, 3),
    tr5y: annualizedToTotal(cagr5, 5),
    tr10y: annualizedToTotal(cagr10, 10),
    // Annualized returns (CAGR nY) come directly from SSGA's "Annualized" figures.
    cagr3y: cagr3,
    cagr5y: cagr5,
    cagr10y: cagr10,
    siAnn,
    // Dividend Yield: SSGA's own official "Fund Dividend Yield" (bulk product
    // data file) when present; falls back to an indicated yield (latest
    // distribution x payments per year / NAV) only for funds missing from
    // that file.
    dividendYield,
    dividendYieldSource: dividendYieldIsOfficial ? 'official' : indicatedDividendYield !== null ? 'indicated' : null,
    dividendYieldBasis: dividendYieldBasisFor(dividendYieldIsOfficial ? 'official' : 'indicated', dividendYield),
    indicatedDividendYield,
    // 30-Day SEC Yield (subsidized + unsubsidized): SSGA does publish this,
    // in the bulk product-data file.
    secYield,
    secYieldUnsubsidized,
  };
  for (const key of ['tr1y', 'tr3y', 'tr5y', 'tr10y', 'cagr3y', 'cagr5y', 'cagr10y', 'siAnn', 'indicatedDividendYield']) {
    metrics[`${key}Text`] = percentText(metrics[key] as number | null);
  }
  metrics.dividendYieldText = dividendYieldIsOfficial
    ? productData?.fundDividendYield?.display ?? percentText(dividendYield)
    : percentText(dividendYield);
  metrics.secYieldText = productData?.secYield?.display ?? percentText(secYield);
  metrics.secYieldUnsubsidizedText = productData?.secYieldUnsubsidized?.display ?? percentText(secYieldUnsubsidized);
  metrics.ytdText = percentText(metrics.ytd as number | null);
  // Contract fields (STANDARD.md 9a), always last. performanceAsOf is the month-end
  // performance table date (the date the returns are as of), not the NAV date.
  metrics.returnsBasis = RETURNS_BASIS;
  metrics.performanceAsOf = toIsoDate(monthEnd.asOfDate);
  return metrics;
}

function pairValue(pair: unknown): { display: string | null; value: number | null } {
  if (Array.isArray(pair) && pair.length >= 2) {
    const value = typeof pair[1] === 'number' && !isMissingNumber(pair[1]) ? pair[1] : null;
    const display = cleanText(pair[0]);
    if (display === '' || display === '-') return { display: null, value };
    return { display, value };
  }
  const display = cleanText(pair);
  if (display === '' || display === '-') return { display: null, value: null };
  const value = Number(display.replace(/[$,%\s]/g, ''));
  return { display, value: Number.isFinite(value) && !isMissingNumber(value) ? value : null };
}

const RETURN_FIELDS: Array<[string, string]> = [
  ['mo1', 'Month'],
  ['qtd', 'QTD'],
  ['ytd', 'YTD'],
  ['yr1', '1Y'],
  ['yr3', '3Y'],
  ['yr5', '5Y'],
  ['yr10', '10Y'],
  ['sinceInception', 'SI Ann.'],
];

function normalizeReturns(record: JsonRecord, suffix: string): JsonRecord {
  const asOf = pairValue(record[`PerfAsOf${suffix}`]);
  const out: JsonRecord = { asOfDate: asOf.display };
  for (const [key] of RETURN_FIELDS) {
    const { display, value } = pairValue(record[`${key}${suffix}`]);
    out[key] = value;
    out[`${key}Text`] = display;
  }
  if (suffix === '') out.inceptionDate = pairValue(record.inceptionDate).display;
  return out;
}

function assetClassByTicker(categories: JsonRecord[]): Map<string, string> {
  const map = new Map<string, string>();
  const walk = (node: JsonRecord, topName: string) => {
    const tickerList = typeof node.funds === 'string' ? node.funds : '';
    if (tickerList) {
      for (const raw of tickerList.split('|')) {
        const ticker = sanitizeTicker(raw);
        if (ticker && !map.has(ticker)) map.set(ticker, topName);
      }
    }
    for (const child of node.subCategories || []) walk(child, topName);
  };
  for (const root of categories) {
    if (root.key !== 'assetclass') continue;
    for (const child of root.subCategories || []) walk(child, cleanText(child.name) || String(child.key));
  }
  return map;
}

function normalizeCatalog(payload: JsonRecord): CatalogFund[] {
  const etfs = payload?.data?.funds?.etfs || {};
  const datas: JsonRecord[] = etfs.datas || [];
  const categoryMap = assetClassByTicker(etfs.categories || []);
  const funds: CatalogFund[] = [];
  for (const record of datas) {
    const ticker = sanitizeTicker(record.fundTicker);
    if (!ticker) continue;
    const ter = pairValue(record.ter);
    const nav = pairValue(record.nav);
    const aum = pairValue(record.aum);
    const close = pairValue(record.closePrice);
    const premium = pairValue(record.premiumDiscount);
    const monthEnd = normalizeReturns(record, '');
    const quarterEnd = normalizeReturns(record, '_1');
    const factsheetDoc = (record.documentPdf || [])
      .flatMap((group: JsonRecord) => group.docs || [])
      .find((doc: JsonRecord) => typeof doc.path === 'string' && doc.path.endsWith('.pdf'));
    const fundUri = cleanText(record.fundUri);
    funds.push({
      ticker,
      name: cleanText(record.fundName),
      fundPage: fundUri ? `${SSGA_SITE}${fundUri}` : '',
      category: categoryMap.get(ticker) || 'ETF',
      ter: ter.display,
      terValue: ter.value,
      nav: nav.display,
      navValue: nav.value,
      aum: aum.display,
      aumValue: aum.value !== null ? aum.value * 1_000_000 : null,
      asOfDate: pairValue(record.asOfDate).display,
      inceptionDate: monthEnd.inceptionDate || null,
      exchange: cleanText(record.primaryExchange) || null,
      closePrice: close.display,
      closePriceValue: close.value,
      premiumDiscount: premium.display,
      premiumDiscountValue: premium.value,
      monthEnd,
      quarterEnd,
      factsheetUrl: factsheetDoc?.path ? `${SSGA_SITE}${factsheetDoc.path}` : null,
    });
  }
  funds.sort((a, b) => a.ticker.localeCompare(b.ticker));
  return funds;
}

/**
 * TER standard: `terValue` is the NET expense ratio (after waivers; the single published figure when there is
 * no waiver), `terGrossValue` the GROSS one. SSGA's fund finder and the product-data workbook publish the gross
 * ratio, the workbook also carries the net one.
 */
export function expenseRatios(
  fund: { ter: string | null; terValue: number | null },
  productData?: ProductDataRow | null,
): { ter: string | null; terValue: number | null; terGross: string | null; terGrossValue: number | null } {
  const gross = productData?.grossExpenseRatio?.value != null
    ? productData.grossExpenseRatio
    : { display: fund.ter, value: fund.terValue };
  const net = productData?.netExpenseRatio?.value != null ? productData.netExpenseRatio : null;
  const chosen = net ?? gross;
  return { ter: chosen.display, terValue: chosen.value, terGross: gross.display, terGrossValue: gross.value };
}

function catalogFromIndex(previous: JsonRecord): CatalogFund[] {
  return (previous.funds || []).map((fund: JsonRecord) => ({
    ticker: sanitizeTicker(fund.ticker),
    name: String(fund.name ?? ''),
    fundPage: String(fund.fundPage ?? ''),
    category: String(fund.category ?? 'ETF'),
    // The index carries the net ratio in ter/terValue; the catalog stores the gross one.
    ter: fund.terGross ?? fund.ter ?? null,
    terValue: fund.terGrossValue ?? fund.terValue ?? null,
    nav: fund.nav ?? null,
    navValue: fund.navValue ?? null,
    aum: fund.aum ?? null,
    aumValue: fund.aumValue ?? null,
    asOfDate: fund.asOfDate ?? null,
    inceptionDate: fund.inceptionDate ?? null,
    exchange: fund.exchange ?? null,
    closePrice: fund.closePrice ?? null,
    closePriceValue: fund.closePriceValue ?? null,
    premiumDiscount: fund.premiumDiscount ?? null,
    premiumDiscountValue: fund.premiumDiscountValue ?? null,
    monthEnd: fund.returns?.monthEnd ?? {},
    quarterEnd: fund.returns?.quarterEnd ?? {},
    factsheetUrl: null,
  }));
}

// ---------------------------------------------------------------------------
// Distributions feed (latest dividend row per fund)
// ---------------------------------------------------------------------------

function normalizeDistributions(payload: JsonRecord): Map<string, JsonRecord> {
  const map = new Map<string, JsonRecord>();
  for (const group of payload?.data || []) {
    for (const frequency of group.frequencyData || []) {
      const frequencyName = cleanText(frequency.name) || cleanText(group.name);
      for (const fund of frequency.fund || []) {
        const ticker = sanitizeTicker(fund.fundTicker);
        if (!ticker || map.has(ticker)) continue;
        map.set(ticker, {
          frequency: frequencyName,
          exDate: cleanText(fund.exDate),
          recordDate: cleanText(fund.recordDate),
          payableDate: cleanText(fund.payableDate),
          dividend: cleanText(fund.dividend),
          stCapGains: cleanText(fund.shortTeamCapital),
          ltCapGains: cleanText(fund.longTeamCapital),
        });
      }
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Deterministic JSON writing (content-stable, no empty diffs)
// ---------------------------------------------------------------------------

async function writeIfChanged(file: URL, value: unknown): Promise<boolean> {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const path = decodeURIComponent(file.pathname);
  try {
    const existing = await readFile(path, 'utf8');
    if (existing === text) return false;
  } catch {
    // New file.
  }
  await mkdir(decodeURIComponent(new URL('.', file).pathname), { recursive: true });
  // Atomic: a crash mid-write never leaves a truncated JSON file behind.
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, text, 'utf8');
  await rename(temp, path);
  return true;
}

type PageManifest = { totalRows: number; pageSize: number; pageCount: number; pages: string[]; asOfDate?: string; status?: 'ok' | 'empty' };
type PagesResult = { manifest: PageManifest; kept: Set<string>; changed: boolean };

async function writePages(
  fundDir: URL,
  kind: 'holdings' | 'history' | 'premium-discount',
  table: SheetTable,
  ticker: string,
  asOfDate: string | undefined,
  pageSize: number,
): Promise<PagesResult> {
  const rows = table.rows.map((row) => Object.fromEntries(table.headers.map((header, index) => [header, row[index] ?? ''])));
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const pages: string[] = [];
  const kept = new Set<string>();
  let changed = false;
  for (let page = 1; page <= pageCount; page += 1) {
    const fileName = `${pad3(page)}.json`;
    changed = (await writeIfChanged(new URL(`${kind}/${fileName}`, fundDir), {
      ticker,
      page,
      pageSize,
      totalRows: rows.length,
      headers: table.headers,
      rows: rows.slice((page - 1) * pageSize, page * pageSize),
    })) || changed;
    pages.push(`./${kind}/${fileName}`);
    kept.add(fileName);
  }
  return {
    manifest: { totalRows: rows.length, pageSize, pageCount, pages, asOfDate: asOfDate || undefined },
    kept,
    changed,
  };
}

/** Removes pages the new manifest no longer lists; call only AFTER the new meta.json is written. */
async function removeStalePages(
  fundDir: URL,
  kind: 'holdings' | 'history' | 'premium-discount',
  kept: Set<string>,
): Promise<boolean> {
  const dirPath = decodeURIComponent(new URL(`${kind}/`, fundDir).pathname);
  let entries: string[] = [];
  try {
    entries = await readdir(dirPath);
  } catch {
    return false;
  }
  let removed = false;
  for (const entry of entries) {
    if (!kept.has(entry)) {
      await rm(`${dirPath}${entry}`, { force: true });
      removed = true;
    }
  }
  return removed;
}

/**
 * A shorter HISTORY_RANGE window must not delete older published history: rows older than the new window are
 * carried over from the pages already on disk, so the written history is the union (new window wins on overlap).
 */
export async function mergeOlderRows(fundDir: URL, kind: 'history' | 'premium-discount', table: SheetTable): Promise<SheetTable> {
  const dateIndex = table.headers.findIndex((header) => header.toLowerCase() === 'date');
  if (dateIndex < 0) return table;
  const dates = table.rows.map((row) => historyDate(row[dateIndex] ?? '')).filter((date): date is number => date !== null);
  if (!dates.length) return table;
  const oldest = Math.min(...dates);
  const descending = (historyDate(table.rows[0]?.[dateIndex] ?? '') ?? 0) >= (historyDate(table.rows[table.rows.length - 1]?.[dateIndex] ?? '') ?? 0);
  const dirPath = decodeURIComponent(new URL(`${kind}/`, fundDir).pathname);
  let names: string[] = [];
  try { names = (await readdir(dirPath)).filter((name) => /^\d+\.json$/.test(name)).sort(); } catch { return table; }
  const older: string[][] = [];
  for (const name of names) {
    let page: JsonRecord;
    try { page = JSON.parse(await readFile(`${dirPath}${name}`, 'utf8')); } catch { continue; }
    if (JSON.stringify(page.headers) !== JSON.stringify(table.headers)) return table;
    for (const row of page.rows || []) {
      const cells = table.headers.map((header) => String(row?.[header] ?? ''));
      const date = historyDate(cells[dateIndex]);
      if (date !== null && date < oldest) older.push(cells);
    }
  }
  if (!older.length) return table;
  return { headers: table.headers, rows: descending ? [...table.rows, ...older] : [...older, ...table.rows] };
}

// ---------------------------------------------------------------------------
// Update state (bounded-run cursor, daggerok/iShares semantics)
// ---------------------------------------------------------------------------

type UpdateState = { version: number; scope: JsonRecord; lastProcessedTicker: string | null };

async function readUpdateState(): Promise<UpdateState | null> {
  try {
    return JSON.parse(await readFile(decodeURIComponent(STATE_FILE.pathname), 'utf8'));
  } catch {
    return null;
  }
}

/** The filter set a cursor belongs to; a cursor saved under another filter set is ignored. */
function cursorScope(config: UpdaterConfig): JsonRecord {
  const range = (value?: Range): string | null => (value ? `${value.min ?? ''}:${value.max ?? ''}` : null);
  return {
    aumRange: config.aumRange?.source ?? null,
    terRange: range(config.terRange),
    dividendYieldRange: range(config.dividendYieldRange),
    secYieldRange: range(config.secYieldRange),
    performanceRanges: config.performanceRanges,
    totalReturnRanges: config.totalReturnRanges,
  };
}

async function writeUpdateState(config: UpdaterConfig, lastProcessedTicker: string | null): Promise<void> {
  const state: UpdateState = { version: 1, scope: cursorScope(config), lastProcessedTicker };
  await writeIfChanged(STATE_FILE, state);
}

/**
 * Bounded-run order: the selected funds (already filtered, sorted by ticker) rotated to start right after the
 * cursor ticker, wrapping around. The cursor ticker need not be selected any more.
 */
export function rotateAfterCursor<T extends { ticker: string }>(selected: T[], lastProcessedTicker: string | null): T[] {
  if (!lastProcessedTicker) return selected;
  const start = selected.findIndex((fund) => fund.ticker.localeCompare(lastProcessedTicker) > 0);
  return start <= 0 ? selected : [...selected.slice(start), ...selected.slice(0, start)];
}

// ---------------------------------------------------------------------------
// Fund processing
// ---------------------------------------------------------------------------

type FundStatus = 'updated' | 'unchanged' | 'skipped' | 'failed';
type FundResult = { ticker: string; status: FundStatus; reason?: string; changed: boolean };

async function fetchJson(url: string, label: string): Promise<JsonRecord> {
  const response = await fetchWithRetry(url, label);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return (await response.json()) as JsonRecord;
}

async function fetchXlsx(url: string, label: string): Promise<{ bytes: Uint8Array; rows: string[][] }> {
  const response = await fetchWithRetry(url, label);
  if (!response.ok) throw new Error(`${label}: ${response.status} ${response.statusText}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { bytes, rows: parseXlsxSheet(bytes, loadSharedStrings(bytes)) };
}

function catalogFiltersPass(fund: CatalogFund, config: UpdaterConfig, productData?: ProductDataRow | null): boolean {
  if (config.tickers.length && !config.tickers.includes(fund.ticker)) return false;
  if (!matchesRange(fund.aumValue, config.aumRange, Boolean((config.aumRange as any)?.maxExclusive))) return false;
  if (!matchesRange(expenseRatios(fund, productData).terValue, config.terRange)) return false;
  return true;
}

const PERIOD_FIELD: Record<ReturnPeriod, string> = { YTD: 'ytd', '1Y': 'yr1', '3Y': 'yr3', '5Y': 'yr5', '10Y': 'yr10' };

function yieldFiltersPass(metrics: JsonRecord, config: UpdaterConfig): boolean {
  return matchesRange(metrics.dividendYield as number | null, config.dividendYieldRange) && matchesRange(metrics.secYield as number | null, config.secYieldRange);
}

function returnFiltersPass(fund: CatalogFund, config: UpdaterConfig): boolean {
  for (const period of RETURN_PERIODS) {
    const performance = config.performanceRanges[period];
    if (performance && !matchesRange(fund.monthEnd[PERIOD_FIELD[period]], performance)) return false;
    const totalReturn = config.totalReturnRanges[period];
    if (totalReturn && !matchesRange(fund.quarterEnd[PERIOD_FIELD[period]], totalReturn)) return false;
  }
  return true;
}

function distributionsWorksheet(distribution: JsonRecord | undefined): { headers: string[]; rows: string[][] } {
  if (!distribution) return { headers: [], rows: [] };
  return {
    headers: ['Frequency', 'Ex-Date', 'Record Date', 'Payable Date', 'Dividend', 'ST Cap Gains', 'LT Cap Gains'],
    rows: [
      [
        distribution.frequency,
        distribution.exDate,
        distribution.recordDate,
        distribution.payableDate,
        distribution.dividend,
        distribution.stCapGains,
        distribution.ltCapGains,
      ].map((cell) => String(cell ?? '')),
    ],
  };
}

async function processFund(
  fund: CatalogFund,
  distribution: JsonRecord | undefined,
  productData: ProductDataRow | undefined,
  config: UpdaterConfig,
): Promise<FundResult> {
  const { ticker } = fund;
  const fundDir = new URL(`funds/${ticker}/`, API_ROOT);
  try {
    const holdingsUrl = `${FUND_DATA_BASE}/holdings-daily-us-en-${ticker.toLowerCase()}.xlsx`;
    const historyUrl = `${FUND_DATA_BASE}/navhist-us-en-${ticker.toLowerCase()}.xlsx`;
    const pdHistUrl = `${FUND_DATA_BASE}/pdhist-us-en-${ticker.toLowerCase()}.xlsx`;

    // Phase 1: fetch and compute everything in memory. Any failure here leaves the fund exactly as published before.
    const holdingsResponse = await fetchWithRetry(holdingsUrl, `[fetch  ] ${ticker} holdings`);
    let holdingsBytes: Uint8Array | null = null;
    let holdings: { meta: JsonRecord; table: SheetTable } = { meta: {}, table: { headers: [], rows: [] } };
    if (holdingsResponse.status === 404) {
      // Commodity trusts (GLD, GLDM, ...) hold metal, not securities, and publish no holdings workbook: valid, status "empty".
      // But a 404 for a fund that published holdings before is treated as a failure so published rows are kept.
      const previousMeta = await readFile(decodeURIComponent(new URL('meta.json', fundDir).pathname), 'utf8').then(JSON.parse).catch(() => null);
      if ((previousMeta?.holdings?.totalRows ?? 0) > 0) throw new Error('holdings: 404 for a fund with published holdings, keeping the previous data');
    } else if (!holdingsResponse.ok) {
      throw new Error(`holdings: ${holdingsResponse.status} ${holdingsResponse.statusText}`);
    } else {
      holdingsBytes = new Uint8Array(await holdingsResponse.arrayBuffer());
      holdings = sheetToTable(parseXlsxSheet(holdingsBytes, loadSharedStrings(holdingsBytes)), 'holdings');
    }

    const history = await fetchXlsx(historyUrl, `[fetch  ] ${ticker} navhist`);
    const historyTable = sheetToTable(history.rows, 'history');
    historyTable.table = applyHistoryRange(historyTable.table, config.historyRange);
    if (config.historyRange !== 'max') historyTable.table = await mergeOlderRows(fundDir, 'history', historyTable.table);

    // Not every fund publishes a daily Premium/Discount history workbook.
    const pdHistResponse = await fetchWithRetry(pdHistUrl, `[fetch  ] ${ticker} pdhist`);
    let pdHistBytes: Uint8Array | null = null;
    let pdTable: SheetTable | null = null;
    if (pdHistResponse.status === 404) {
      // no-op: no premium/discount workbook for this fund.
    } else if (!pdHistResponse.ok) {
      throw new Error(`pdhist: ${pdHistResponse.status} ${pdHistResponse.statusText}`);
    } else {
      pdHistBytes = new Uint8Array(await pdHistResponse.arrayBuffer());
      pdTable = sheetToTable(parseXlsxSheet(pdHistBytes, loadSharedStrings(pdHistBytes)), 'premium-discount').table;
      pdTable = applyHistoryRange(pdTable, config.historyRange);
      if (config.historyRange !== 'max') pdTable = await mergeOlderRows(fundDir, 'premium-discount', pdTable);
    }

    // Phase 2: write once. Pages first, then meta.json, then stale pages are removed.
    if (config.storeRawDownloads) {
      const rawDir = decodeURIComponent(new URL('raw/', API_ROOT).pathname);
      await mkdir(rawDir, { recursive: true });
      if (holdingsBytes) await writeFile(`${rawDir}${ticker}-holdings.xlsx`, holdingsBytes);
      await writeFile(`${rawDir}${ticker}-navhist.xlsx`, history.bytes);
      if (pdHistBytes) await writeFile(`${rawDir}${ticker}-pdhist.xlsx`, pdHistBytes);
    }

    const premiumDiscountResult = pdTable
      ? await writePages(fundDir, 'premium-discount', pdTable, ticker, pdTable.rows[0]?.[0], config.historyPageSize)
      : null;
    const holdingsResult = await writePages(fundDir, 'holdings', holdings.table, ticker, holdings.meta.asOfDate, config.holdingsPageSize);
    holdingsResult.manifest.status = holdings.table.rows.length ? 'ok' : 'empty';
    const historyResult = await writePages(fundDir, 'history', historyTable.table, ticker, historyTable.meta.asOfDate, config.historyPageSize);

    const ratios = expenseRatios(fund, productData);
    const meta = {
      ticker,
      name: fund.name,
      category: fund.category,
      identifiers: { isin: productData?.isin ?? null, cusip: productData?.cusip ?? null },
      source: {
        fundPage: fund.fundPage,
        holdingsDownload: holdingsUrl,
        navDownload: historyUrl,
        premiumDiscountDownload: pdHistUrl,
        productDataDownload: PRODUCT_DATA_URL,
        factsheet: fund.factsheetUrl,
      },
      // value = net expense ratio (gross when no waiver is published); gross is always listed alongside
      expenseRatio: { display: ratios.ter, value: ratios.terValue, gross: { display: ratios.terGross, value: ratios.terGrossValue } },
      netExpenseRatio: productData?.netExpenseRatio ?? { display: null, value: null },
      nav: { display: fund.nav, value: fund.navValue, asOfDate: fund.asOfDate },
      aum: { display: fund.aum, value: fund.aumValue, asOfDate: fund.asOfDate },
      pricing: { exchange: fund.exchange, closePrice: fund.closePrice, premiumDiscount: fund.premiumDiscount },
      inceptionDate: fund.inceptionDate,
      returns: { monthEnd: fund.monthEnd, quarterEnd: fund.quarterEnd },
      metrics: deriveCatalogMetrics(fund.monthEnd, fund.navValue, distribution, productData),
      distributions: distributionsWorksheet(distribution),
      holdings: holdingsResult.manifest,
      history: historyResult.manifest,
      premiumDiscountHistory: premiumDiscountResult ? premiumDiscountResult.manifest : null,
    };
    const metaChanged = await writeIfChanged(new URL('meta.json', fundDir), meta);
    let changed = metaChanged || holdingsResult.changed || historyResult.changed || Boolean(premiumDiscountResult?.changed);
    for (const [kind, result] of [['holdings', holdingsResult], ['history', historyResult], ['premium-discount', premiumDiscountResult]] as const) {
      if (result && (await removeStalePages(fundDir, kind, result.kept))) changed = true;
    }

    return { ticker, status: changed ? 'updated' : 'unchanged', changed };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    return { ticker, status: 'failed', reason, changed: false };
  }
}

// --- TLS trust store (identical in every ETF repo) ---
const SYSTEM_CA_MARKER = 'ETF_UPDATER_SYSTEM_CA';
const CERT_ERROR = /UNABLE_TO_GET_ISSUER_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT|CERT_HAS_EXPIRED|unable to get (?:local )?issuer certificate|self[- ]signed certificate|certificate has expired/i;

export function isCertError(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown; cause?: unknown } | null;
  return CERT_ERROR.test(`${String(e?.code ?? '')} ${String(e?.message ?? '')}`) || (e?.cause ? isCertError(e.cause) : false);
}

export function systemCaActive(env: Record<string, string | undefined> = process.env, execArgv: string[] = process.execArgv): boolean {
  return execArgv.includes('--use-system-ca') || env.NODE_USE_SYSTEM_CA === '1' || env[SYSTEM_CA_MARKER] === '1';
}

export function reexecWithSystemCa(): never {
  const child = Bun.spawnSync([process.execPath, '--use-system-ca', ...process.argv.slice(1)], {
    env: { ...process.env, [SYSTEM_CA_MARKER]: '1' },
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  process.exit(child.exitCode ?? 1);
}

/** mode: auto (restart once on an untrusted-certificate error), true (restart now), false (never). */
export function installSystemCa(mode: string, reexec: () => never = reexecWithSystemCa, active: boolean = systemCaActive()): void {
  if (mode === 'false' || active) return;
  if (mode === 'true') reexec();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    try { return await realFetch(...args); }
    catch (error) {
      if (!isCertError(error)) throw error;
      console.error('[ notice   ] TLS certificate not trusted; restarting once with --use-system-ca');
      return reexec();
    }
  }) as typeof fetch;
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

export async function main(env: Record<string, string | undefined> = process.env): Promise<void> {
  const startedAt = Date.now();
  const controls = await runtimeControls(env);
  installSystemCa(controls.USE_SYSTEM_CA.toLowerCase());
  if (controls.VERBOSE !== undefined && env === process.env) process.env.VERBOSE = controls.VERBOSE;
  const config = loadConfig(controls);
  requestSleepSeconds = config.requestSleep;
  lastRequestAtLanes = new Array(Math.max(1, config.concurrency)).fill(0);
  maxRetriesConfig = config.maxRetries;

  outputPrintConfig('SPDR', config);

  const previousIndex: JsonRecord | null = await (async () => {
    try {
      return JSON.parse(await readFile(decodeURIComponent(INDEX_FILE.pathname), 'utf8'));
    } catch {
      return null;
    }
  })();

  let catalog: CatalogFund[] = [];
  try {
    catalog = normalizeCatalog(await fetchJson(FUND_FINDER_URL, '[catalog] fundfinder'));
  } catch (error) {
    console.warn(`[ ${'catalog'.padEnd(9)}] fundfinder failed (${(error as Error).message})`);
  }
  if (!catalog.length && previousIndex?.funds?.length) {
    console.warn(`[ ${'catalog'.padEnd(9)}] falling back to ${previousIndex.funds.length} published funds`);
    catalog = catalogFromIndex(previousIndex);
  }
  if (!catalog.length) throw new Error('No SPDR funds discovered and no previous catalog to fall back to');

  const distributions = await (async () => {
    try {
      return normalizeDistributions(await fetchJson(DISTRIBUTIONS_URL, '[distr  ] dividend-distribution'));
    } catch (error) {
      console.warn(`[ ${'distr'.padEnd(9)}] dividend feed failed (${(error as Error).message}); continuing without it`);
      return new Map<string, JsonRecord>();
    }
  })();

  // Bulk product-data workbook: official ISIN/CUSIP/SEC yield/dividend yield
  // for the whole lineup in one file (see parseProductDataSheet).
  const productData = await (async () => {
    try {
      const response = await fetchWithRetry(PRODUCT_DATA_URL, '[catalog] product-data');
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (config.storeRawDownloads) {
        const rawDir = new URL('raw/', API_ROOT).pathname;
        await mkdir(rawDir, { recursive: true });
        await writeFile(`${rawDir}product-data.xlsx`, bytes);
      }
      return parseProductDataSheet(bytes);
    } catch (error) {
      console.warn(`[ ${'catalog'.padEnd(9)}] product-data failed (${(error as Error).message}); continuing without it`);
      return new Map<string, ProductDataRow>();
    }
  })();

  const unknownTickers = config.tickers.filter((ticker) => !catalog.some((fund) => fund.ticker === ticker));
  if (unknownTickers.length) throw new Error(`TICKERS: unknown ticker(s) ${unknownTickers.join(', ')} (not in the SPDR catalog)`);

  const previousRows = new Map<string, JsonRecord>((previousIndex?.funds || []).map((row: JsonRecord) => [row.ticker, row]));
  if (previousRows.size) {
    const newFunds = catalog.map((fund) => fund.ticker).filter((ticker) => !previousRows.has(ticker));
    if (newFunds.length) {
      console.log(`NEW FUNDS: ${newFunds.join(', ')}`);
      if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `### NEW FUNDS\n\n${newFunds.join(', ')}\n`, 'utf8');
    }
  }

  // Every filter is applied before the cursor, so a bounded run counts only funds that pass the filters.
  // Return filters exclude funds with null for a bounded range (matchesRange treats null as no match).
  const selected = catalog.filter(
    (fund) =>
      catalogFiltersPass(fund, config, productData.get(fund.ticker)) &&
      returnFiltersPass(fund, config) &&
      yieldFiltersPass(deriveCatalogMetrics(fund.monthEnd, fund.navValue, distributions.get(fund.ticker), productData.get(fund.ticker)), config),
  );
  outputPrintFilter(selected.length, catalog.length);

  // Bounded runs continue after the committed cursor (deterministic ticker order), only for the same filter set.
  const state = await readUpdateState();
  const cursorUsable = state !== null && outputContentKey(state.scope) === outputContentKey(cursorScope(config));
  const ordered = config.maxFetches > 0 && cursorUsable ? rotateAfterCursor(selected, state!.lastProcessedTicker) : selected;
  const batch = config.maxFetches > 0 ? ordered.slice(0, config.maxFetches) : ordered;

  const output = outputCreateReporter(API_ROOT, batch.length);
  const results: FundResult[] = [];
  let cursorIndex = 0;
  let deadlineHit = false;
  async function worker(): Promise<void> {
    for (;;) {
      if (Date.now() - startedAt > softDeadlineMs) {
        deadlineHit = true;
        return;
      }
      const index = cursorIndex++;
      if (index >= batch.length) return;
      const fund = batch[index];
      const before = await output.before(fund.ticker);
      const result = await processFund(fund, distributions.get(fund.ticker), productData.get(fund.ticker), config);
      results.push(result);
      await output.result(fund.ticker, before, result.status === 'failed' || result.status === 'skipped' ? result.status : undefined, result.reason);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, config.concurrency) }, () => worker()));
  const taken = Math.min(cursorIndex, batch.length);
  if (deadlineHit) console.warn(`[ ${'deadline'.padEnd(9)}] soft deadline reached; ${batch.length - results.length} selected funds not started, index still written`);

  // Live details from disk for refreshed funds.
  const refreshed = new Set(results.filter((result) => result.status === 'updated' || result.status === 'unchanged').map((result) => result.ticker));
  const fileExists = (path: string): Promise<boolean> => access(path).then(() => true, () => false);
  const metaPath = (ticker: string): string => decodeURIComponent(new URL(`funds/${ticker}/meta.json`, API_ROOT).pathname);
  const counts = new Map<string, { holdings: number; history: number; premiumDiscount: number; holdingsStatus: string | null }>();
  for (const ticker of refreshed) {
    try {
      const meta = JSON.parse(await readFile(metaPath(ticker), 'utf8'));
      counts.set(ticker, {
        holdings: meta.holdings?.totalRows ?? 0,
        history: meta.history?.totalRows ?? 0,
        premiumDiscount: meta.premiumDiscountHistory?.totalRows ?? 0,
        holdingsStatus: meta.holdings?.status ?? null,
      });
    } catch {
      // Keep previous counts.
    }
  }

  const freshRow = async (fund: CatalogFund): Promise<JsonRecord> => {
    const previous = previousRows.get(fund.ticker) || {};
    const live = counts.get(fund.ticker);
    const distribution = distributions.get(fund.ticker);
    const productRow = productData.get(fund.ticker);
    const ratios = expenseRatios(fund, productRow);
    return {
      ticker: fund.ticker,
      name: fund.name,
      category: fund.category,
      fundPage: fund.fundPage,
      // null (never a dangling path) when the fund has no funds/<T>/meta.json
      dataFile: (await fileExists(metaPath(fund.ticker))) ? `./funds/${fund.ticker}/meta.json` : null,
      isin: productRow?.isin ?? previous.isin ?? null,
      cusip: productRow?.cusip ?? previous.cusip ?? null,
      // terValue = net expense ratio (the single figure when no waiver), terGrossValue = gross
      ter: ratios.ter,
      terValue: ratios.terValue,
      terGross: ratios.terGross,
      terGrossValue: ratios.terGrossValue,
      netExpenseRatio: productRow?.netExpenseRatio ?? previous.netExpenseRatio ?? null,
      nav: fund.nav,
      navValue: fund.navValue,
      aum: fund.aum,
      aumValue: fund.aumValue,
      asOfDate: fund.asOfDate,
      inceptionDate: fund.inceptionDate,
      exchange: fund.exchange,
      closePrice: fund.closePrice,
      closePriceValue: fund.closePriceValue,
      premiumDiscount: fund.premiumDiscount,
      premiumDiscountValue: fund.premiumDiscountValue,
      distributions: distribution
        ? { frequency: distribution.frequency, exDate: distribution.exDate, dividend: distribution.dividend }
        : null,
      metrics: deriveCatalogMetrics(fund.monthEnd, fund.navValue, distribution, productRow),
      returns: { monthEnd: fund.monthEnd, quarterEnd: fund.quarterEnd },
      holdings: live?.holdings ?? previous.holdings ?? 0,
      holdingsStatus: live?.holdingsStatus ?? previous.holdingsStatus ?? null,
      history: live?.history ?? previous.history ?? 0,
      premiumDiscountHistory: live?.premiumDiscount ?? previous.premiumDiscountHistory ?? 0,
    };
  };

  // Fund-level consistency: a refreshed fund gets a fresh row; any other fund keeps its previous row untouched
  // (never a new return next to stale files). Funds with a meta.json that left the catalog stay listed.
  const indexFunds: JsonRecord[] = [];
  const catalogTickers = new Set(catalog.map((fund) => fund.ticker));
  for (const fund of catalog) {
    const previous = previousRows.get(fund.ticker);
    if (refreshed.has(fund.ticker) || !previous) indexFunds.push(await freshRow(fund));
    else indexFunds.push({ ...previous, metrics: withYieldBasis(previous.metrics), dataFile: (await fileExists(metaPath(fund.ticker))) ? `./funds/${fund.ticker}/meta.json` : null });
  }
  for (const [ticker, previous] of previousRows) {
    if (!catalogTickers.has(ticker) && (await fileExists(metaPath(ticker)))) indexFunds.push({ ...previous, metrics: withYieldBasis(previous.metrics) });
  }
  indexFunds.sort((a, b) => String(a.ticker).localeCompare(String(b.ticker)));

  const indexPayload = {
    generatedAt: previousIndex?.generatedAt || '',
    source: {
      provider: 'SSGA / State Street (SPDR)',
      market: 'us',
      site: SSGA_SITE,
      catalog: FUND_FINDER_URL,
      productData: PRODUCT_DATA_URL,
    },
    counts: {
      funds: indexFunds.length,
      holdings: indexFunds.reduce((sum, fund) => sum + (fund.holdings || 0), 0),
      history: indexFunds.reduce((sum, fund) => sum + (fund.history || 0), 0),
      premiumDiscountHistory: indexFunds.reduce((sum, fund) => sum + (fund.premiumDiscountHistory || 0), 0),
    },
    funds: indexFunds,
  };
  // The stamp moves only when some content moved, so an identical rerun leaves a zero git diff.
  if (!previousIndex || outputContentKey(indexPayload) !== outputContentKey(previousIndex) || !indexPayload.generatedAt) {
    indexPayload.generatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  const indexChanged = await writeIfChanged(INDEX_FILE, indexPayload);

  // A TICKERS run must never overwrite the cursor of the real bounded rotation.
  if (config.maxFetches > 0 && taken > 0 && !config.tickers.length) {
    await writeUpdateState(config, batch[taken - 1]?.ticker ?? null);
  }

  const failed = results.filter((result) => result.status === 'failed').length;
  const skipped = results.filter((result) => result.status === 'skipped').length;
  const updated = results.filter((result) => result.status === 'updated').length;
  const unchanged = results.filter((result) => result.status === 'unchanged').length;
  console.log(
    `\n[ ${'summary'.padEnd(9)}] processed=${results.length} updated=${updated} unchanged=${unchanged} skipped=${skipped} failed=${failed} indexChanged=${indexChanged} elapsed=${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
  );

  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `### SPDR data update\n\n- processed: ${results.length}\n- updated: ${updated}\n- unchanged: ${unchanged}\n- skipped: ${skipped}\n- failed: ${failed}\n- index changed: ${indexChanged}\n`,
      'utf8',
    );
  }
  if (results.length > 0 && failed === results.length) throw new Error(`all ${failed} selected funds failed`);
}

// ---------------------------------------------------------------------------
// Controls: config file < advanced JSON < nonblank inputs < environment
// ---------------------------------------------------------------------------

// Allowlisted scalar controls only, so GitHub Actions can resolve them without
// interpolating user input into bash. The CLI and the workflow share
// resolveControls(). Precedence: scripts/update-data.config.json < advanced
// JSON < nonblank dispatch inputs < environment (`<KEY>`, then the legacy
// `SPDR_<KEY>` alias; any defined value, even empty, overrides).
export const CONTROL_NAMES = [
  'MAX_FETCHES', 'REQUEST_SLEEP', 'CONCURRENCY', 'AUM', 'TER', 'DIVIDEND_YIELD', 'SEC_YIELD', 'TICKERS',
  'HOLDINGS_PAGE_SIZE', 'HISTORY_PAGE_SIZE', 'HISTORY_RANGE', 'STORE_RAW_DOWNLOADS', 'MAX_RETRIES', 'VERBOSE', 'USE_SYSTEM_CA',
  ...['PERFORMANCE', 'TOTAL_RETURN'].flatMap((prefix) => ['YTD', '1Y', '3Y', '5Y', '10Y'].map((period) => `${prefix}_${period}`)),
] as const;
export type ControlName = (typeof CONTROL_NAMES)[number];
export const CONFIG_FILE_URL = new URL('./update-data.config.json', import.meta.url);

export function resolveControls(
  file: unknown = {},
  advanced: unknown = {},
  inputs: unknown = {},
  env: Record<string, string | undefined> = {},
): Record<string, string> {
  const result: Record<string, string> = {};
  const known = new Set<string>(CONTROL_NAMES);
  const apply = (value: unknown, skipEmpty = false): void => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Configuration must be a JSON object');
    for (const [key, raw] of Object.entries(value)) {
      if (!known.has(key)) throw new Error(`Unknown updater control: ${key}`);
      if (skipEmpty && (raw === '' || raw === undefined || raw === null)) continue;
      if (!['string', 'number', 'boolean'].includes(typeof raw)) throw new Error(`${key}: expected string, number or boolean`);
      const text = String(raw);
      if (/[\r\n\0]/.test(text)) throw new Error(`${key}: multiline/control characters are not allowed`);
      result[key] = text;
    }
  };
  apply(file);
  apply(advanced);
  apply(inputs, true);
  for (const key of CONTROL_NAMES) {
    const value = env[key] ?? env[`SPDR_${key}`];
    if (value !== undefined) apply({ [key]: value });
  }
  for (const key of ['MAX_FETCHES', 'CONCURRENCY', 'HOLDINGS_PAGE_SIZE', 'HISTORY_PAGE_SIZE', 'MAX_RETRIES']) {
    const v = result[key]?.trim();
    if (v === undefined || v === '') continue;
    const min = key === 'MAX_FETCHES' ? 0 : 1;
    if (!/^\d+$/.test(v) || !Number.isSafeInteger(Number(v)) || Number(v) < min) throw new Error(`${key}: expected integer >= ${min}`);
  }
  if (result.REQUEST_SLEEP?.trim() && (!Number.isFinite(parseDecimal(result.REQUEST_SLEEP.trim())) || parseDecimal(result.REQUEST_SLEEP.trim()) < 0)) {
    throw new Error('REQUEST_SLEEP: expected nonnegative seconds');
  }
  for (const key of ['STORE_RAW_DOWNLOADS', 'VERBOSE']) {
    if (result[key]?.trim() && !/^(0|1|true|false|yes|no|y|n|on|off)$/i.test(result[key].trim())) throw new Error(`${key}: expected boolean`);
  }
  if (result.USE_SYSTEM_CA !== undefined && !/^(auto|true|false)$/i.test(result.USE_SYSTEM_CA.trim())) throw new Error('USE_SYSTEM_CA: expected auto, true or false');
  loadConfig(result); // validate every min:max filter before any request or write
  return result;
}

export async function runtimeControls(env: Record<string, string | undefined> = process.env): Promise<Record<string, string>> {
  let file: unknown = {};
  try { file = JSON.parse(await outputReadFile(CONFIG_FILE_URL, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return resolveControls(file, {}, {}, env);
}

// ---------------------------------------------------------------------------
// Entry point (kept at the end: main() relies on the let bindings above)
// ---------------------------------------------------------------------------

if (import.meta.main) {
  if (process.argv.includes('-h') || process.argv.includes('--help')) {
    printHelp();
  } else {
    await main().catch((error: unknown) => {
      console.error(`[ ${'error'.padEnd(9)}] ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
  }
}
