#!/usr/bin/env bun

// SPDR (State Street Global Advisors) static data updater.
// Fetches the public SPDR US ETF catalog, per-fund daily holdings XLSX,
// NAV history XLSX, and the latest dividend distribution, then writes a
// deterministic, paginated static JSON API under ./api/spdr, following the
// daggerok/iShares repository design (no dependencies, Bun only).

import { mkdir, readFile, writeFile, readdir, rm, appendFile } from 'node:fs/promises';
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
const SSGA_SITE = 'https://www.ssga.com';

const API_ROOT = new URL('../api/spdr/', import.meta.url);
const INDEX_FILE = new URL('index.json', API_ROOT);
const STATE_FILE = new URL('update-state.json', API_ROOT);

const HOLDINGS_PAGE_SIZE_FALLBACK = 250;
const HISTORY_PAGE_SIZE_FALLBACK = 1000;
const CONCURRENCY_FALLBACK = 2;
const REQUEST_SLEEP_FALLBACK = 1;
const MAX_RETRIES_FALLBACK = 2;
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

function envValue(env: Record<string, string | undefined>, name: string, aliases: string[] = []): string {
  for (const key of [name, `SPDR_${name}`, ...aliases]) {
    const value = env[key];
    if (value !== undefined && value.trim() !== '') return value.trim();
  }
  return '';
}

function parsePositiveInt(raw: string, fallback: number): number {
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function parseBoolean(raw: string): boolean {
  return ['1', 'true', 'yes', 'y', 'on'].includes(raw.toLowerCase());
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
  } else if (left.max !== undefined && parts[0].trim() !== '') {
    range.max = left.max;
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

function loadConfig(env: Record<string, string | undefined>): UpdaterConfig {
  const performanceRanges: RangeMap = {};
  const totalReturnRanges: RangeMap = {};
  for (const period of RETURN_PERIODS) {
    const performance = parseRange(envValue(env, `PERFORMANCE_${period}`), `PERFORMANCE_${period}`);
    if (performance) performanceRanges[period] = performance;
    const totalReturn = parseRange(envValue(env, `TOTAL_RETURN_${period}`), `TOTAL_RETURN_${period}`);
    if (totalReturn) totalReturnRanges[period] = totalReturn;
  }
  return {
    concurrency: parsePositiveInt(envValue(env, 'CONCURRENCY'), CONCURRENCY_FALLBACK),
    requestSleep: Math.max(
      0,
      Number.isFinite(parseDecimal(envValue(env, 'REQUEST_SLEEP', ['SPDR_REQUEST_SLEEP'])))
        ? parseDecimal(envValue(env, 'REQUEST_SLEEP', ['SPDR_REQUEST_SLEEP']))
        : REQUEST_SLEEP_FALLBACK,
    ),
    maxFetches: Math.max(0, Number.parseInt(envValue(env, 'MAX_FETCHES'), 10) || 0),
    holdingsPageSize: parsePositiveInt(envValue(env, 'HOLDINGS_PAGE_SIZE'), HOLDINGS_PAGE_SIZE_FALLBACK),
    historyPageSize: parsePositiveInt(envValue(env, 'HISTORY_PAGE_SIZE'), HISTORY_PAGE_SIZE_FALLBACK),
    storeRawDownloads: parseBoolean(envValue(env, 'STORE_RAW_DOWNLOADS')),
    maxRetries: Math.min(5, Math.max(0, Number.parseInt(envValue(env, 'MAX_RETRIES'), 10) || 0) || MAX_RETRIES_FALLBACK),
    tickers: envValue(env, 'TICKERS')
      .split(/[\s,;]+/)
      .map(sanitizeTicker)
      .filter(Boolean),
    aumRange: parseAumRange(envValue(env, 'AUM')),
    terRange: parseRange(envValue(env, 'TER'), 'TER'),
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
    '  - Distributions:   latest dividend distribution per fund',
    '',
    'Environment variables (all optional; AND logic when combined):',
    '  TICKERS             Space/comma/semicolon ticker allowlist, e.g. "SPY XLK".',
    '  AUM                 min:max range; bounds are USD amounts (K/M/B/T suffixes',
    '                      allowed) or nano/micro/small/mid/large presets.',
    '  TER                 min:max inclusive expense-ratio range in %.',
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
    '  MAX_RETRIES         Retries after the first attempt (default 2).',
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

let lastRequestAt = 0;
let requestSleepSeconds = REQUEST_SLEEP_FALLBACK;
let maxRetriesConfig = MAX_RETRIES_FALLBACK;

async function paceRequests(): Promise<void> {
  const gap = requestSleepSeconds * 1000;
  const elapsed = Date.now() - lastRequestAt;
  if (elapsed < gap) await sleep(gap - elapsed);
  lastRequestAt = Date.now();
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

async function fetchWithRetry(url: string, label: string): Promise<Response> {
  let attempt = 0;
  for (;;) {
    await paceRequests();
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
        redirect: 'follow',
      });
      // SSGA front doors (Akamai) answer 403 while rate-limited; patience recovers.
      if (response.status === 403) {
        await response.arrayBuffer().catch(() => undefined);
        if (attempt >= maxRetriesConfig) throw new Error(`403 rate limited after ${attempt + 1} attempts: ${label}`);
        const waitSeconds = 15 * (attempt + 1);
        console.warn(
          `[retry  ] ${label} status=403 attempt=${attempt + 1}/${maxRetriesConfig + 1} waiting=${waitSeconds}s`,
        );
        await sleep(waitSeconds * 1000);
        attempt += 1;
        continue;
      }
      if (response.ok) return response;
      if (RETRYABLE_STATUS.has(response.status) && attempt < maxRetriesConfig) {
        const waitSeconds = Math.min(30, 2 ** attempt * 3);
        console.warn(
          `[retry  ] ${label} status=${response.status} attempt=${attempt + 1}/${maxRetriesConfig + 1} waiting=${waitSeconds}s`,
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
      console.warn(
        `[retry  ] ${label} error=${(error as Error).message} attempt=${attempt + 1}/${maxRetriesConfig + 1} waiting=${waitSeconds}s`,
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
export function sheetToTable(rawRows: string[][], kind: 'holdings' | 'history'): { meta: JsonRecord; table: SheetTable } {
  const meta: JsonRecord = {};
  let headerIndex = rawRows.findIndex((row) => {
    const filled = row.filter((cell) => cell !== '').length;
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
// CAGRs, so CAGR comes straight from SSGA's yrN figures and TR nY is derived
// as (1 + cagr)^n - 1 (the exact inverse of annualizing a cumulative return).
// SSGA publishes no SEC 30-day yield -> rendered as "—" (documented limitation).
// Dividend Yield is an *indicated* yield: latest distribution x payments per
// year / NAV (SSGA publishes no trailing-12M distribution history per fund).
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

export function deriveCatalogMetrics(
  monthEnd: JsonRecord,
  navValue: number | null,
  distribution: { frequency?: string | null; exDate?: string | null; dividend?: string | null } | null | undefined,
): JsonRecord {
  const numberOrNull = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  const cagr1 = numberOrNull(monthEnd.yr1);
  const cagr3 = numberOrNull(monthEnd.yr3);
  const cagr5 = numberOrNull(monthEnd.yr5);
  const cagr10 = numberOrNull(monthEnd.yr10);
  const siAnn = numberOrNull(monthEnd.sinceInception);
  const dividendYield = indicatedYield(distribution, navValue);
  const metrics: JsonRecord = {
    // Cumulative total returns (TR nY). SSGA's 1Y annualized equals the 1Y total.
    tr1y: cagr1,
    tr3y: annualizedToTotal(cagr3, 3),
    tr5y: annualizedToTotal(cagr5, 5),
    tr10y: annualizedToTotal(cagr10, 10),
    // Annualized returns (CAGR nY) come directly from SSGA's "Annualized" figures.
    cagr3y: cagr3,
    cagr5y: cagr5,
    cagr10y: cagr10,
    siAnn,
    // Indicated dividend yield (latest distribution x frequency / NAV); no trailing-12M feed.
    dividendYield,
    // SSGA does not publish a 30-day SEC yield for SPDR ETFs.
    secYield: null,
  };
  for (const key of ['tr1y', 'tr3y', 'tr5y', 'tr10y', 'cagr3y', 'cagr5y', 'cagr10y', 'siAnn', 'dividendYield']) {
    metrics[`${key}Text`] = percentText(metrics[key] as number | null);
  }
  metrics.secYieldText = null;
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

function catalogFromIndex(previous: JsonRecord): CatalogFund[] {
  return (previous.funds || []).map((fund: JsonRecord) => ({
    ticker: sanitizeTicker(fund.ticker),
    name: String(fund.name ?? ''),
    fundPage: String(fund.fundPage ?? ''),
    category: String(fund.category ?? 'ETF'),
    ter: fund.ter ?? null,
    terValue: fund.terValue ?? null,
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
  await mkdir(new URL('.', file).pathname, { recursive: true });
  await writeFile(path, text, 'utf8');
  return true;
}

type PageManifest = { totalRows: number; pageSize: number; pageCount: number; pages: string[]; asOfDate?: string };

async function writePages(
  fundDir: URL,
  kind: 'holdings' | 'history',
  table: SheetTable,
  ticker: string,
  asOfDate: string | undefined,
  pageSize: number,
): Promise<{ manifest: PageManifest; kept: Set<string> }> {
  const rows = table.rows.map((row) => Object.fromEntries(table.headers.map((header, index) => [header, row[index] ?? ''])));
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const pages: string[] = [];
  const kept = new Set<string>();
  for (let page = 1; page <= pageCount; page += 1) {
    const fileName = `${pad3(page)}.json`;
    await writeIfChanged(new URL(`${kind}/${fileName}`, fundDir), {
      ticker,
      page,
      pageSize,
      totalRows: rows.length,
      headers: table.headers,
      rows: rows.slice((page - 1) * pageSize, page * pageSize),
    });
    pages.push(`./${kind}/${fileName}`);
    kept.add(fileName);
  }
  return {
    manifest: { totalRows: rows.length, pageSize, pageCount, pages, asOfDate: asOfDate || undefined },
    kept,
  };
}

async function removeStalePages(fundDir: URL, kind: 'holdings' | 'history', kept: Set<string>): Promise<void> {
  const dirPath = decodeURIComponent(new URL(`${kind}/`, fundDir).pathname);
  let entries: string[] = [];
  try {
    entries = await readdir(dirPath);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!kept.has(entry)) await rm(`${dirPath}${entry}`, { force: true });
  }
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

async function writeUpdateState(config: UpdaterConfig, lastProcessedTicker: string | null): Promise<void> {
  const state: UpdateState = {
    version: 1,
    scope: {
      tickers: config.tickers,
      aumRange: config.aumRange?.source ?? null,
      terRange: config.terRange ? `${config.terRange.min ?? ''}:${config.terRange.max ?? ''}` : null,
      performanceRanges: config.performanceRanges,
      totalReturnRanges: config.totalReturnRanges,
    },
    lastProcessedTicker,
  };
  await writeIfChanged(STATE_FILE, state);
}

// ---------------------------------------------------------------------------
// Fund processing
// ---------------------------------------------------------------------------

type FundStatus = 'updated' | 'unchanged' | 'skipped' | 'failed';
type FundResult = { ticker: string; status: FundStatus; reason?: string; changed: boolean };

async function fetchJson(url: string, label: string): Promise<JsonRecord> {
  const response = await fetchWithRetry(url, label);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

async function fetchXlsx(url: string, label: string): Promise<{ bytes: Uint8Array; rows: string[][] }> {
  const response = await fetchWithRetry(url, label);
  if (!response.ok) throw new Error(`${label}: ${response.status} ${response.statusText}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { bytes, rows: parseXlsxSheet(bytes, loadSharedStrings(bytes)) };
}

function catalogFiltersPass(fund: CatalogFund, config: UpdaterConfig): boolean {
  if (config.tickers.length && !config.tickers.includes(fund.ticker)) return false;
  if (!matchesRange(fund.aumValue, config.aumRange, Boolean((config.aumRange as any)?.maxExclusive))) return false;
  if (!matchesRange(fund.terValue, config.terRange)) return false;
  return true;
}

const PERIOD_FIELD: Record<ReturnPeriod, string> = { YTD: 'ytd', '1Y': 'yr1', '3Y': 'yr3', '5Y': 'yr5', '10Y': 'yr10' };

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
  config: UpdaterConfig,
  index: number,
  total: number,
): Promise<FundResult> {
  const { ticker } = fund;
  const fundDir = new URL(`funds/${ticker}/`, API_ROOT);
  try {
    const holdingsUrl = `${FUND_DATA_BASE}/holdings-daily-us-en-${ticker.toLowerCase()}.xlsx`;
    const historyUrl = `${FUND_DATA_BASE}/navhist-us-en-${ticker.toLowerCase()}.xlsx`;

    const holdingsResponse = await fetchWithRetry(holdingsUrl, `[fetch  ] ${ticker} holdings`);
    if (holdingsResponse.status === 404) {
      // Commodity trusts (GLD, SLV, ...) do not publish a holdings spreadsheet.
      console.log(`[fund   ] ${ticker.padEnd(8)} ${String(index + 1).padStart(3)}/${total} status=skipped reason=no holdings file`);
      return { ticker, status: 'skipped', reason: 'no holdings file', changed: false };
    }
    if (!holdingsResponse.ok) {
      throw new Error(`holdings: ${holdingsResponse.status} ${holdingsResponse.statusText}`);
    }
    const holdingsBytes = new Uint8Array(await holdingsResponse.arrayBuffer());
    const holdings = sheetToTable(parseXlsxSheet(holdingsBytes, loadSharedStrings(holdingsBytes)), 'holdings');

    const history = await fetchXlsx(historyUrl, `[fetch  ] ${ticker} navhist`);
    const historyTable = sheetToTable(history.rows, 'history');

    if (config.storeRawDownloads) {
      const rawDir = new URL('raw/', API_ROOT).pathname;
      await mkdir(rawDir, { recursive: true });
      await writeFile(`${rawDir}${ticker}-holdings.xlsx`, holdingsBytes);
      await writeFile(`${rawDir}${ticker}-navhist.xlsx`, history.bytes);
    }

    const holdingsResult = await writePages(fundDir, 'holdings', holdings.table, ticker, holdings.meta.asOfDate, config.holdingsPageSize);
    const historyResult = await writePages(fundDir, 'history', historyTable.table, ticker, historyTable.meta.asOfDate, config.historyPageSize);
    await removeStalePages(fundDir, 'holdings', holdingsResult.kept);
    await removeStalePages(fundDir, 'history', historyResult.kept);

    const meta = {
      ticker,
      name: fund.name,
      category: fund.category,
      source: {
        fundPage: fund.fundPage,
        holdingsDownload: holdingsUrl,
        navDownload: historyUrl,
        factsheet: fund.factsheetUrl,
      },
      expenseRatio: { display: fund.ter, value: fund.terValue },
      nav: { display: fund.nav, value: fund.navValue, asOfDate: fund.asOfDate },
      aum: { display: fund.aum, value: fund.aumValue, asOfDate: fund.asOfDate },
      pricing: { exchange: fund.exchange, closePrice: fund.closePrice, premiumDiscount: fund.premiumDiscount },
      inceptionDate: fund.inceptionDate,
      returns: { monthEnd: fund.monthEnd, quarterEnd: fund.quarterEnd },
      distributions: distributionsWorksheet(distribution),
      holdings: holdingsResult.manifest,
      history: historyResult.manifest,
    };
    const changed = await writeIfChanged(new URL('meta.json', fundDir), meta);
    console.log(`[fund   ] ${ticker.padEnd(8)} ${String(index + 1).padStart(3)}/${total} status=${changed ? 'updated' : 'unchanged'}`);
    return { ticker, status: changed ? 'updated' : 'unchanged', changed };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[fund   ] ${ticker.padEnd(8)} ${String(index + 1).padStart(3)}/${total} status=failed reason=${reason}`);
    return { ticker, status: 'failed', reason, changed: false };
  }
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const startedAt = Date.now();
  const config = loadConfig(process.env);
  requestSleepSeconds = config.requestSleep;
  maxRetriesConfig = config.maxRetries;

  console.log(
    `[config ] concurrency=%d sleep=%ss maxFetches=%s tickers=%d aum=%s ter=%s`,
    config.concurrency,
    config.requestSleep,
    config.maxFetches || 'all',
    config.tickers.length,
    config.aumRange?.source ?? ':',
    config.terRange ? `${config.terRange.min ?? ''}:${config.terRange.max ?? ''}` : ':',
  );

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
    console.warn(`[catalog] fundfinder failed (${(error as Error).message})`);
  }
  if (!catalog.length && previousIndex?.funds?.length) {
    console.warn(`[catalog] falling back to ${previousIndex.funds.length} published funds`);
    catalog = catalogFromIndex(previousIndex);
  }
  if (!catalog.length) throw new Error('No SPDR funds discovered and no previous catalog to fall back to');

  const distributions = await (async () => {
    try {
      return normalizeDistributions(await fetchJson(DISTRIBUTIONS_URL, '[distr  ] dividend-distribution'));
    } catch (error) {
      console.warn(`[distr  ] dividend feed failed (${(error as Error).message}); continuing without it`);
      return new Map<string, JsonRecord>();
    }
  })();

  const eligible = catalog.filter((fund) => catalogFiltersPass(fund, config));
  console.log(`[catalog] ${catalog.length} funds, ${eligible.length} eligible after catalog filters`);

  // Bounded runs continue after the committed cursor (deterministic ticker order).
  const state = await readUpdateState();
  let ordered = eligible;
  if (config.maxFetches > 0 && state?.lastProcessedTicker) {
    const cursor = ordered.findIndex((fund) => fund.ticker === state.lastProcessedTicker);
    if (cursor >= 0) ordered = [...ordered.slice(cursor + 1), ...ordered.slice(0, cursor + 1)];
  }
  const batch = config.maxFetches > 0 ? ordered.slice(0, config.maxFetches) : ordered;

  const results: FundResult[] = [];
  let cursorIndex = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = cursorIndex++;
      if (index >= batch.length) return;
      const fund = batch[index];
      if (!returnFiltersPass(fund, config)) {
        console.log(`[fund   ] ${fund.ticker.padEnd(8)} ${String(index + 1).padStart(3)}/${batch.length} status=skipped reason=return filter`);
        results.push({ ticker: fund.ticker, status: 'skipped', reason: 'return filter', changed: false });
        continue;
      }
      results.push(await processFund(fund, distributions.get(fund.ticker), config, index, batch.length));
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, config.concurrency) }, () => worker()));

  // Live counts from disk for processed funds; previous counts otherwise.
  const counts = new Map<string, { holdings: number; history: number }>();
  for (const result of results) {
    if (result.status === 'failed' || result.status === 'skipped') continue;
    try {
      const meta = JSON.parse(
        await readFile(decodeURIComponent(new URL(`funds/${result.ticker}/meta.json`, API_ROOT).pathname), 'utf8'),
      );
      counts.set(result.ticker, { holdings: meta.holdings?.totalRows ?? 0, history: meta.history?.totalRows ?? 0 });
    } catch {
      // Keep previous counts.
    }
  }

  const indexFunds = catalog.map((fund) => {
    const previous = previousIndex?.funds?.find((entry: JsonRecord) => entry.ticker === fund.ticker) || {};
    const live = counts.get(fund.ticker);
    const distribution = distributions.get(fund.ticker);
    return {
      ticker: fund.ticker,
      name: fund.name,
      category: fund.category,
      fundPage: fund.fundPage,
      dataFile: `./funds/${fund.ticker}/meta.json`,
      ter: fund.ter,
      terValue: fund.terValue,
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
      metrics: deriveCatalogMetrics(fund.monthEnd, fund.navValue, distribution),
      returns: { monthEnd: fund.monthEnd, quarterEnd: fund.quarterEnd },
      holdings: live?.holdings ?? previous.holdings ?? 0,
      history: live?.history ?? previous.history ?? 0,
    };
  });

  const anyChanged = results.some((result) => result.changed);
  const indexPayload = {
    generatedAt: anyChanged ? new Date().toISOString() : previousIndex?.generatedAt || new Date().toISOString(),
    source: { provider: 'SSGA / State Street (SPDR)', market: 'us', site: SSGA_SITE, catalog: FUND_FINDER_URL },
    counts: {
      funds: indexFunds.length,
      holdings: indexFunds.reduce((sum, fund) => sum + (fund.holdings || 0), 0),
      history: indexFunds.reduce((sum, fund) => sum + (fund.history || 0), 0),
    },
    funds: indexFunds,
  };
  const indexChanged = await writeIfChanged(INDEX_FILE, indexPayload);

  if (config.maxFetches > 0 && batch.length) {
    await writeUpdateState(config, batch[batch.length - 1]?.ticker ?? null);
  }

  const failed = results.filter((result) => result.status === 'failed').length;
  const skipped = results.filter((result) => result.status === 'skipped').length;
  const updated = results.filter((result) => result.status === 'updated').length;
  const unchanged = results.filter((result) => result.status === 'unchanged').length;
  console.log(
    `\n[summary] processed=${results.length} updated=${updated} unchanged=${unchanged} skipped=${skipped} failed=${failed} indexChanged=${indexChanged} elapsed=${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
  );

  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `### SPDR data update\n\n- processed: ${results.length}\n- updated: ${updated}\n- unchanged: ${unchanged}\n- skipped: ${skipped}\n- failed: ${failed}\n- index changed: ${indexChanged}\n`,
      'utf8',
    );
  }
}

// ---------------------------------------------------------------------------
// Entry point (kept at the end: main() relies on the let bindings above)
// ---------------------------------------------------------------------------

if (import.meta.main) {
  if (process.argv.includes('-h') || process.argv.includes('--help')) {
    printHelp();
  } else {
    await main();
  }
}
