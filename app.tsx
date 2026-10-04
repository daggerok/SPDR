/**
 * @file SPDR Watchlist Application
 * Client-side static feed viewer for api/spdr/** with multi-ETF Watchlist
 * aggregation. Same single-file approach as daggerok/Amplify: the paginated
 * static API and lazy sheet loading follow daggerok/iShares.
 *
 * Babel standalone note: the inline pipeline strips type annotations, but it
 * does not accept every TypeScript-only expression. Follow the Amplify dev
 * style — plain `byId()` instead of DOM casts, no `as` casts, no non-null
 * `!`, no interfaces or enums.
 */

// =========================================================================
// 1. Types, constants & column tooltips
// =========================================================================

type ActiveTab = string;
type SortDirection = 'asc' | 'desc';
type TableRow = Record<string, unknown> & { searchIndex?: string };
type TabInfo = { id: ActiveTab; label: string; count: number; loading?: boolean; failed?: boolean };

type IndexFund = {
  ticker: string;
  name: string;
  category: string;
  fundPage: string;
  dataFile: string;
  isin: string | null;
  cusip: string | null;
  ter: string;
  terValue: number;
  nav: string;
  navValue: number;
  aum: string;
  aumValue: number;
  asOfDate: string;
  inceptionDate: string;
  exchange: string;
  closePrice: string;
  premiumDiscount: string;
  distributions: { frequency: string; exDate: string; dividend: string };
  returns: { monthEnd: Record<string, any>; quarterEnd: Record<string, any> };
  metrics?: {
    tr1y?: number | null;
    tr3y?: number | null;
    tr5y?: number | null;
    tr10y?: number | null;
    cagr3y?: number | null;
    cagr5y?: number | null;
    cagr10y?: number | null;
    siAnn?: number | null;
    dividendYield?: number | null;
    dividendYieldText?: string | null;
    dividendYieldSource?: 'official' | 'indicated' | null;
    secYield?: number | null;
    secYieldUnsubsidized?: number | null;
  };
  holdings: number;
  history: number;
};

type FundRow = TableRow & {
  ticker: string;
  name: string;
  category: string;
  fundPage: string;
  isin?: string | null;
  cusip?: string | null;
  ter: string;
  terValue: number;
  nav: string;
  navValue: number;
  aum: string;
  aumValue: number;
  asOfDate: string;
  inceptionDate: string;
  exchange: string;
  closePrice: string;
  premiumDiscount: string;
  ytd: number;
  yr1: number;
  yr3: number;
  yr5: number;
  yr10: number;
  si: number;
  tr3y?: number | null;
  tr5y?: number | null;
  tr10y?: number | null;
  cagr3y?: number | null;
  cagr5y?: number | null;
  cagr10y?: number | null;
  dividendYield?: number | null;
  dividendFrequency: string;
  secYield?: number | null;
  returnAsOf: string;
  returns?: { monthEnd: Record<string, any>; quarterEnd: Record<string, any> };
  distributions?: { frequency: string; exDate: string; dividend: string };
  holdings: number;
  history: number;
};

type WatchlistRow = TableRow & {
  symbol: string;
  name: string;
  funds: string[];
  fundCount: number;
  weightSum: number;
  maxWeight: number;
  marketValue: number;
  sectors: string[];
  sector: string;
  cusips: string[];
  identifier: string;
  _key?: string;
};

const INDEX_URL = './api/spdr/index.json';
const THEME_KEY = 'spdr-theme';
const SELECTED_KEY = 'spdr-selected-etfs';
const BLACKLIST_KEY = 'spdr-blacklisted-etfs';
const ACTIVE_FUND_KEY = 'spdr-active-fund';
const SEARCHES_KEY = 'spdr-searches'; // legacy; migrated into FILTERS_KEY
const FILTERS_KEY = 'spdr-tab-filters';
const SORTS_KEY = 'spdr-tab-sorts';
const SITE_STATE_KEY = 'spdr-site-state';
const DEFAULT_SELECTED_TICKERS: string[] = []; // start clean: users choose the funds to compare
const WATCHLIST_PAGE_SIZE = 250;
const MAX_CONCURRENT_HOLDINGS_LOADS = 6;

const DETAIL_TABS: Array<{ key: string; label: string }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'holdings', label: 'Holdings' },
  { key: 'history', label: 'History' },
  { key: 'distributions', label: 'Distributions' },
];

const NUMERIC_SHEET_HEADERS = ['Weight', 'Shares Held', 'Shares Outstanding', 'Total Net Assets', 'Par Value', 'Market Value', 'Coupon', 'NAV'];

// Hover explanations for table headers. Native `title` tooltips, same pattern as daggerok/iShares.
const COLUMN_TOOLTIPS: Record<string, string> = {
  '#': 'Row index in current table view.',
  Use: 'Use / Multi-ETF Selection — Check this box to include this ETF\'s underlying holdings in the combined Watchlist tab.',
  Ticker: 'Ticker Symbol — Unique stock market identifier for the fund or security.',
  'Fund Name': 'Fund Name — Official legal name of the SPDR exchange-traded fund (ETF).',
  Category: 'Asset Class — SSGA asset-class grouping (Equity, Fixed Income Sector, ...).',
  Name: 'Security Name — Full registered legal name of the company or underlying financial asset.',
  Identifier: 'CUSIP / ISIN — Security identifier used when no exchange ticker is published (bonds).',
  SEDOL: 'SEDOL — Stock Exchange Daily Official List identifier.',
  TER: 'Gross Expense Ratio — Total annual fund operating expenses as a % of assets.',
  NAV: 'NAV (Net Asset Value) — Per-share dollar value of the fund.',
  'Net Assets': 'Net Assets (AUM) — Total market value of all fund assets minus liabilities.',
  Weight: 'Weight — Position weight as a percentage of the fund\'s total net assets.',
  'Weight Sum': 'Weight Sum — Summed weight of this holding across all selected ETFs (%).',
  'Max Weight': 'Max Weight — Highest single-fund weight for this holding across selected ETFs (%).',
  '# ETFs': 'Number of selected ETFs that currently hold this security.',
  ETFs: 'Selected ETFs holding this security.',
  Type: 'Asset Class — SSGA asset-class grouping (Equity, Fixed Income Sector, ...). Same source as the category tabs.',
  Expense: 'Gross Expense Ratio — Total annual fund operating expenses as a % of assets.',
  'Dividend Yield': 'Dividend Yield — SSGA\'s own official Fund Dividend Yield from its bulk product-data file when available; falls back to an indicated yield (latest distribution per share x payments per year divided by NAV) only for a fund missing from that file.',
  Frequency: 'Frequency — sortable payment cadence from the SSGA dividend distribution feed: 01 - Monthly, 04 - Quarterly, 06 - Semi-annually, 12 - Annually; 00 denotes unavailable/unknown and 99 denotes irregular.',
  'SEC Yield': 'SEC Yield (30-Day) — SSGA\'s official subsidized 30-day SEC yield, from its bulk product-data file. Shown as "—" only for a fund missing from that file.',
  'YTD Return': 'YTD Return — Cumulative NAV total return since the start of the year, SSGA "Month End" series.',
  'TR 1Y': 'TR 1Y (1-Year Total Return) — NAV total return over the past year, including reinvested distributions.',
  'TR 3Y': 'TR 3Y (3-Year Total Return) — Cumulative NAV total return over 3 years. Derived exactly from SSGA\'s annualized figure: (1 + CAGR 3Y)^3 - 1.',
  'TR 5Y': 'TR 5Y (5-Year Total Return) — Cumulative NAV total return over 5 years. Derived exactly from SSGA\'s annualized figure: (1 + CAGR 5Y)^5 - 1.',
  'TR 10Y': 'TR 10Y (10-Year Total Return) — Cumulative NAV total return over 10 years. Derived exactly from SSGA\'s annualized figure: (1 + CAGR 10Y)^10 - 1.',
  'CAGR 3Y': 'CAGR 3Y (3-Year Compound Annual Growth Rate) — Annualized geometric mean return over 3 years, as published (annualized) by SSGA.',
  'CAGR 5Y': 'CAGR 5Y (5-Year Compound Annual Growth Rate) — Annualized geometric mean return over 5 years, as published (annualized) by SSGA.',
  'CAGR 10Y': 'CAGR 10Y (10-Year Compound Annual Growth Rate) — Annualized geometric mean return over 10 years, as published (annualized) by SSGA.',
  YTD: 'YTD NAV total return, month-end series (SSGA "Month End").',
  '1Y': '1-year NAV return, month-end series.',
  '3Y': '3-year average annual NAV return (CAGR), month-end series.',
  '5Y': '5-year average annual NAV return (CAGR), month-end series.',
  '10Y': '10-year average annual NAV return (CAGR), month-end series.',
  'SI Ann.': 'Since-inception annualized NAV return, month-end series.',
  'Return As Of': 'As-of date of the month-end return series.',
  Inception: 'Fund inception date.',
  Exchange: 'Primary listing exchange.',
  Close: 'Most recent closing market price.',
  'Prem/Disc': 'Premium / Discount — Closing price versus NAV (%).',
  Holdings: 'Rows in the fund\'s latest daily holdings file.',
  History: 'Rows in the fund\'s NAV history file.',
  'As Of': 'NAV / AUM as-of date.',
  'Ex-Date': 'Ex-dividend date of the latest distribution.',
  Dividend: 'Latest dividend per share.',
  Coupon: 'Bond annual coupon rate (%).',
  Maturity: 'Bond maturity date.',
  'Market Value': 'Market Value — Published position value; the Watchlist sums available values across selected ETFs.',
  Sector: 'Sector — Published provider sector classification(s) for the holding.',
  Section: 'Section — Grouping of the overview metric (Fund, Cost, Price, Assets, Returns, Distributions, Holdings).',
  Metric: 'Metric — Overview metric name.',
  Value: 'Overview metric value.',
  Date: 'NAV history date.',
  'Shares Outstanding': 'Fund shares outstanding on that date.',
  'Total Net Assets': 'Fund total net assets on that date (USD).',
};

// =========================================================================
// 2. DOM references, application state & lazy fund data
// =========================================================================

function byId(id: string): any {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element;
}

const el = {
  themeToggle: byId('theme-toggle'),
  tickerCount: byId('ticker-count'),
  subtitle: byId('app-subtitle'),
  searchInput: byId('search-input'),
  searchClearBtn: byId('search-clear-btn'),
  tabsBar: byId('tabs-bar'),
  selectedTabsPanel: byId('selected-tabs-panel'),
  selectedTabsBar: byId('selected-tabs-bar'),
  copyBtn: byId('copy-btn'),
  exportCsvBtn: byId('export-csv-btn'),
  exportTxtBtn: byId('export-txt-btn'),
  resetBtn: byId('reset-btn'),
  blacklistBtn: byId('blacklist-btn'),
  blacklistPanel: byId('blacklist-panel'),
  blacklistInput: byId('blacklist-input'),
  blacklistAddBtn: byId('blacklist-add-btn'),
  blacklistClearBtn: byId('blacklist-clear-btn'),
  blacklistChips: byId('blacklist-chips'),
  blacklistEmpty: byId('blacklist-empty'),
  tableHead: byId('table-head'),
  tableBody: byId('table-body'),
  tableScroll: byId('table-scroll'),
  staticLoadSentinel: byId('static-load-sentinel'),
  staticLoadStatus: byId('static-load-status'),
};

type AppState = {
  funds: FundRow[];
  selected: Set<string>;
  blacklist: Set<string>;
  activeTab: ActiveTab;
  activeFundTicker: string | null;
  queryByTab: Record<string, string>;
  sortKey: string;
  sortDir: SortDirection;
  // Last sort the user explicitly chose (column-header click) per tab. Tab
  // switches restore it instead of falling back to the tab default, so an
  // All ETFs sort like "YTD Return" survives Watchlist / detail round trips.
  sortByTab: Record<string, { key: string; dir: SortDirection }>;
  generatedAt: string | null;
  counts: { funds: number; holdings: number; history: number } | null;
};

const state: AppState = {
  funds: [],
  selected: new Set(),
  blacklist: new Set(),
  activeTab: 'All',
  activeFundTicker: null,
  queryByTab: {},
  sortKey: 'rank',
  sortDir: 'asc',
  sortByTab: {},
  generatedAt: null,
  counts: null,
};

// Lazy per-fund data: meta.json plus accumulated sheet pages (iShares-style).
type SheetEntry = {
  headers: string[];
  rows: string[][];
  nextPage: number;
  manifest: any;
  loading: boolean;
};

const fundMetaCache: Map<string, any> = new Map();
const fundMetaRequests: Map<string, Promise<any>> = new Map();
const fundMetaFailures: Map<string, string> = new Map();
const sheetState: Map<string, SheetEntry> = new Map();
const sheetPageRequests: Map<string, Promise<void>> = new Map();
const sheetLoadFailures: Map<string, string> = new Map();
const holdingsLoadPromises: Map<string, Promise<void>> = new Map();
const holdingsLoadFailures: Set<string> = new Set();
const holdingsLoadWaiters: Array<() => void> = [];
let activeHoldingsLoads = 0;
let sheetGeneration = 0;
let watchlistRevision = 0;
let cachedWatchlistRevision = -1;
let cachedWatchlistRows: WatchlistRow[] = [];
let watchlistVisibleLimit = WATCHLIST_PAGE_SIZE;
let renderedWatchlistTotal = 0;
let selectionDataRefreshTimer: any = null;
const selectionDataChangedTickers: Set<string> = new Set();

// =========================================================================
// 3b. Column types, auto-detection and the column filter engine (pure, no DOM)
// =========================================================================

/**
 * Every column of a table has a type that decides how its cells are compared:
 * text, number, percentage, money, date, date and time, or time of day. The type
 * is detected from a sample of the cell texts (80% of the filled cells must
 * agree) and can be overridden per column with the badge in the header.
 *
 * Filter expressions (one input under every column header):
 *   - the same grammar in every mode: space = AND, comma = OR, a leading ! = NOT,
 *     ? = the value is empty or unavailable, !? = it has a value
 *   - text: word (contains), "two words", =exact, ^starts, ends$, /regex/
 *   - number, percentage, money: >10 >=10 <50 <=50 =22 !=22, ranges 10..50 / ..50 / 10..,
 *     K M B T suffixes (>10B), an optional $ or %
 *   - date, date and time: the same operators and ranges over dates written as 2024,
 *     2024-06, 2024-06-15 or 2024-06-15T14:30; a partial date is the whole period
 *     (=2024 is the whole year), keywords today, yesterday, tomorrow, now and relative
 *     offsets -7d, +2w, -3m, -1y
 *   - time: >09:30, 09:30..16:00, =12:00
 *   Values that are unavailable match only ? and negated conditions.
 */
type ColType = 'string' | 'number' | 'percent' | 'currency' | 'date' | 'datetime' | 'time';

const ALL_COL_TYPES: ColType[] = ['string', 'number', 'percent', 'currency', 'date', 'datetime', 'time'];

const COL_TYPE_LABELS: Record<ColType, string> = { string: 'ABC', number: '123', percent: '%', currency: '$', date: 'D', datetime: 'DT', time: 'T' };

const COL_TYPE_NAMES: Record<ColType, string> = { string: 'text', number: 'number', percent: 'percentage', currency: 'money', date: 'date', datetime: 'date and time', time: 'time of day' };

const COL_TYPE_CLASSES: Record<ColType, string> = {
  string: 'bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300',
  number: 'bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300',
  percent: 'bg-emerald-100 dark:bg-emerald-900/50 text-emerald-700 dark:text-emerald-300',
  currency: 'bg-amber-100 dark:bg-amber-900/50 text-amber-700 dark:text-amber-300',
  date: 'bg-purple-100 dark:bg-purple-900/50 text-purple-700 dark:text-purple-300',
  datetime: 'bg-fuchsia-100 dark:bg-fuchsia-900/50 text-fuchsia-700 dark:text-fuchsia-300',
  time: 'bg-sky-100 dark:bg-sky-900/50 text-sky-700 dark:text-sky-300',
};

const COL_TYPE_PLACEHOLDERS: Record<ColType, string> = {
  string: 'text, !not, "a b"', number: '>10 <50, =22', percent: '>5 <20, 10..15', currency: '>1B, ..500M', date: '>2024-01, -30d..', datetime: '>2024-06-01T09:30', time: '>09:30 <16:00',
};

const COL_TYPE_HELP: Record<ColType, string> = {
  string: 'Text filter: space = AND, comma = OR, !word = NOT, "two words" = phrase, =exact, ^starts, ends$, /regex/, ? = empty, !? = has a value.',
  number: 'Number filter: >10 >=10 <50 <=50 =22 !=22, ranges 10..50 / ..50 / 10.., suffixes K M B T, space = AND, comma = OR, ! = NOT, ? = unavailable, !? = available.',
  percent: 'Percentage filter: >5 <20, 10..15, =12.5 (rounds like the shown value), space = AND, comma = OR, ! = NOT, ? = unavailable, !? = available.',
  currency: 'Money filter: >1B, ..500M, 10..20, suffixes K M B T, an optional $, space = AND, comma = OR, ! = NOT, ? = unavailable, !? = available.',
  date: 'Date filter: >2024-06-01, 2024 (the whole year), 2024-06 (the whole month), 2024-01..2024-06, today, yesterday, -7d, +2w, -3m, -1y, space = AND, comma = OR, ! = NOT, ? = empty.',
  datetime: 'Date and time filter: >2024-06-01T09:30, 2024-06-01 (the whole day), 2024-01..2024-06, today, -7d.., space = AND, comma = OR, ! = NOT, ? = empty.',
  time: 'Time filter: >09:30, 09:30..16:00, =12:00 (the whole minute), space = AND, comma = OR, ! = NOT, ? = empty.',
};

const FILTER_DAY_MS = 86400000;
const EMPTY_CELLS = new Set(['', '-', '--', '–', '—', 'n/a', 'na', 'null', 'none', 'nan']);
const TYPE_SAMPLE_SIZE = 60;
const TYPE_AGREEMENT = 0.8;
const MONTH_ABBR = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_FULL = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MAGNITUDES: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 };

function isEmptyCell(value: string): boolean {
  return EMPTY_CELLS.has(value.trim().toLowerCase());
}

function monthFromName(name: string): number {
  const lower = name.toLowerCase().replace(/\.$/, '');
  const abbr = MONTH_ABBR.indexOf(lower === 'sept' ? 'sep' : lower);
  return abbr >= 0 ? abbr : MONTH_FULL.indexOf(lower);
}

/** UTC milliseconds of a calendar date; NaN when the date does not exist (2024-02-30). */
function utcMs(year: number, month: number, day: number): number {
  const time = Date.UTC(year, month - 1, day);
  const date = new Date(time);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? time : NaN;
}

/** Date in one of the common written forms, as UTC midnight milliseconds; NaN when the text is not a date. */
function parseDatePart(text: string): number {
  const value = text.trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(value);
  if (m) return utcMs(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(value); // US month/day/year unless the first number cannot be a month
  if (m) {
    const first = Number(m[1]);
    const second = Number(m[2]);
    const year = m[3].length === 2 ? (Number(m[3]) < 70 ? 2000 : 1900) + Number(m[3]) : Number(m[3]);
    return first > 12 ? utcMs(year, second, first) : utcMs(year, first, second);
  }
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(value);
  if (m) return utcMs(Number(m[3]), Number(m[2]), Number(m[1]));
  m = /^(\d{1,2})[-\s]([A-Za-z]{3,9})\.?[-\s,]*(\d{4})$/.exec(value);
  if (m && monthFromName(m[2]) >= 0) return utcMs(Number(m[3]), monthFromName(m[2]) + 1, Number(m[1]));
  m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(value);
  if (m && monthFromName(m[1]) >= 0) return utcMs(Number(m[3]), monthFromName(m[1]) + 1, Number(m[2]));
  return NaN;
}

/** Time of day in seconds since midnight (24-hour or AM/PM); NaN when the text is not a time. */
function parseTimePart(text: string): number {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?\s*([AaPp][Mm])?$/.exec(text.trim());
  if (!m) return NaN;
  let hours = Number(m[1]);
  const minutes = Number(m[2]);
  const seconds = m[3] === undefined ? 0 : Number(m[3]);
  if (m[5]) {
    if (hours < 1 || hours > 12) return NaN;
    hours = (hours % 12) + (m[5].toLowerCase() === 'pm' ? 12 : 0);
  }
  if (hours > 23 || minutes > 59 || seconds > 59) return NaN;
  return hours * 3600 + minutes * 60 + seconds + (m[4] ? Number(`0.${m[4]}`) : 0);
}

type Temporal = { kind: 'date' | 'datetime' | 'time'; value: number };

/** A date (UTC midnight ms), a date with a time (UTC ms, an offset such as Z or +02:00 is honored) or a time of day (seconds). */
function parseTemporal(raw: string): Temporal | null {
  const text = raw.trim();
  if (!text) return null;
  const time = parseTimePart(text);
  if (Number.isFinite(time)) return { kind: 'time', value: time };
  const date = parseDatePart(text);
  if (Number.isFinite(date)) return { kind: 'date', value: date };
  const m = /^(.+?)(?:T|\s+)(\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:\s*[AaPp][Mm])?)\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(text);
  if (!m) return null;
  const day = parseDatePart(m[1]);
  const clock = parseTimePart(m[2]);
  if (!Number.isFinite(day) || !Number.isFinite(clock)) return null;
  let ms = day + clock * 1000;
  if (m[3] && m[3] !== 'Z') {
    const digits = m[3].slice(1).replace(':', '');
    ms -= (m[3][0] === '-' ? -1 : 1) * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2))) * 60000;
  }
  return { kind: 'datetime', value: ms };
}

type Magnitude = { value: number; decimals: number; scale: number; percent: boolean; currency: boolean };

/** $1,234.50, (12.5), -3.2%, 5B, +1.2 pp, 12x: the number with the precision and the unit it was written with. */
function parseMagnitude(raw: string): Magnitude | null {
  let text = raw.trim();
  let negative = false;
  const paren = /^\((.*)\)$/.exec(text);
  if (paren) { negative = true; text = paren[1].trim(); }
  const m = /^([+-]?)\s*([$€£¥]?)\s*([+-]?)\s*(\d[\d,]*(?:\.\d*)?|\.\d+)\s*([kmbtKMBT])?\s*(%|pp|bp|x)?$/.exec(text);
  if (!m) return null;
  if (m[1] === '-' || m[3] === '-') negative = !negative;
  const digits = m[4].replace(/,/g, '');
  const scale = m[5] ? MAGNITUDES[m[5].toLowerCase()] : 1;
  const value = Number(digits) * scale;
  if (!Number.isFinite(value)) return null;
  return { value: negative ? -value : value, decimals: digits.includes('.') ? digits.length - digits.indexOf('.') - 1 : 0, scale, percent: m[6] === '%', currency: m[2] !== '' };
}

/** The sortable and filterable number behind a cell text for its column type; NaN when there is none. */
function parseCellValue(text: string, type: ColType): number {
  if (type === 'string') return NaN;
  if (type === 'number' || type === 'percent' || type === 'currency') {
    const magnitude = parseMagnitude(text);
    return magnitude ? magnitude.value : NaN;
  }
  const temporal = parseTemporal(text);
  if (!temporal) return NaN;
  if (type === 'time') return temporal.kind === 'time' ? temporal.value : NaN;
  if (temporal.kind === 'time') return NaN;
  if (type === 'date') return Math.floor(temporal.value / 86400000) * 86400000;
  return temporal.value;
}

/** Detects the type of a column from sample cell texts: 80% of the filled cells must agree, otherwise text. */
function detectColType(samples: string[]): ColType {
  const values = samples.map(sample => String(sample ?? '').trim()).filter(value => !isEmptyCell(value)).slice(0, TYPE_SAMPLE_SIZE);
  if (!values.length) return 'string';
  const need = Math.ceil(values.length * TYPE_AGREEMENT);
  const count = { date: 0, datetime: 0, time: 0, percent: 0, currency: 0, number: 0 };
  values.forEach(value => {
    const temporal = parseTemporal(value);
    if (temporal) { count[temporal.kind] += 1; return; }
    const magnitude = parseMagnitude(value);
    if (!magnitude) return;
    if (magnitude.percent) count.percent += 1;
    else if (magnitude.currency) count.currency += 1;
    else count.number += 1;
  });
  if (count.date + count.datetime >= need) return count.datetime > 0 ? 'datetime' : 'date';
  if (count.time >= need) return 'time';
  if (count.percent >= need) return 'percent';
  if (count.currency >= need || count.currency + count.number >= need && count.currency > 0) return 'currency';
  if (count.number >= need) return 'number';
  return 'string';
}

// ---- filter expressions ---------------------------------------------------------

type FilterToken = { op: string; text: string; neg: boolean; quoted: boolean; regex: boolean; flags: string };

/** Splits an expression into AND tokens grouped by commas (OR groups); quotes keep spaces, !/>= prefixes may precede a quote. */
function tokenizeFilter(input: string): FilterToken[][] {
  const groups: FilterToken[][] = [[]];
  let i = 0;
  const length = input.length;
  while (i < length) {
    const char = input[i];
    if (char === ' ' || char === '\t') { i += 1; continue; }
    if (char === ',') { groups.push([]); i += 1; continue; }
    let neg = false;
    if (char === '!') { neg = true; i += 1; }
    let prefix = '';
    const op = /^(>=|<=|!=|==|=|>|<|\^)/.exec(input.slice(i));
    if (op) { prefix = op[1]; i += prefix.length; }
    let text = '';
    let quoted = false;
    let regex = false;
    let flags = '';
    if (input[i] === '"' || input[i] === "'") {
      const quote = input[i];
      quoted = true;
      i += 1;
      while (i < length && input[i] !== quote) { text += input[i]; i += 1; }
      if (i < length) i += 1;
    } else if (input[i] === '/' && prefix === '') {
      const end = input.indexOf('/', i + 1);
      if (end > i) {
        regex = true;
        text = input.slice(i + 1, end);
        i = end + 1;
        while (i < length && /[a-z]/i.test(input[i])) { flags += input[i]; i += 1; }
      }
    }
    if (!quoted && !regex) {
      while (i < length && input[i] !== ' ' && input[i] !== '\t' && input[i] !== ',') { text += input[i]; i += 1; }
    }
    const token = { op: prefix, text, neg, quoted, regex, flags };
    if (token.text !== '' || token.op !== '' || token.neg || token.quoted || token.regex) groups[groups.length - 1].push(token);
  }
  return groups.filter(group => group.length > 0);
}

type Interval = { lo: number; hi: number };
type Condition =
  | { kind: 'empty'; neg: boolean }
  | { kind: 'text'; mode: 'contains' | 'exact' | 'starts' | 'ends' | 'regex'; value: string; re: RegExp | null; neg: boolean }
  | { kind: 'cmp'; op: '=' | '>' | '>=' | '<' | '<=' | 'range'; a: Interval | null; b: Interval | null; temporal: boolean; neg: boolean };

type CompiledFilter = { ok: true; test: (num: number, text: string) => boolean } | { ok: false; error: string };

function startOfUtcDay(ms: number): number {
  return Math.floor(ms / FILTER_DAY_MS) * FILTER_DAY_MS;
}

/** A written date or time as the half-open interval [lo, hi) it denotes (2024 is the whole year); null when it is not valid for the column type. */
function temporalInterval(text: string, type: ColType, now: number): Interval | null {
  const word = text.trim().toLowerCase();
  if (type === 'time') {
    if (word === 'now') { const t = (now % FILTER_DAY_MS) / 1000; return { lo: t, hi: t + 1 }; }
    const t = parseTimePart(word);
    if (!Number.isFinite(t)) return null;
    return { lo: t, hi: t + (/^\d{1,2}:\d{2}(?:\s*[ap]m)?$/.test(word) ? 60 : 1) };
  }
  const today = startOfUtcDay(now);
  if (word === 'now') return { lo: now, hi: now + 1 };
  if (word === 'today') return { lo: today, hi: today + FILTER_DAY_MS };
  if (word === 'yesterday') return { lo: today - FILTER_DAY_MS, hi: today };
  if (word === 'tomorrow') return { lo: today + FILTER_DAY_MS, hi: today + 2 * FILTER_DAY_MS };
  const relative = /^([+-]?)(\d+)\s*([dwmy])$/.exec(word);
  if (relative) {
    const amount = (relative[1] === '-' ? -1 : 1) * Number(relative[2]);
    const base = new Date(today);
    if (relative[3] === 'd') base.setUTCDate(base.getUTCDate() + amount);
    else if (relative[3] === 'w') base.setUTCDate(base.getUTCDate() + amount * 7);
    else if (relative[3] === 'm') base.setUTCMonth(base.getUTCMonth() + amount);
    else base.setUTCFullYear(base.getUTCFullYear() + amount);
    const lo = base.getTime();
    return { lo, hi: lo + FILTER_DAY_MS };
  }
  let m = /^(\d{4})$/.exec(word);
  if (m) return { lo: utcMs(Number(m[1]), 1, 1), hi: utcMs(Number(m[1]) + 1, 1, 1) };
  m = /^(\d{4})[-/.](\d{1,2})$/.exec(word);
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]);
    if (month < 1 || month > 12) return null;
    return { lo: utcMs(year, month, 1), hi: month === 12 ? utcMs(year + 1, 1, 1) : utcMs(year, month + 1, 1) };
  }
  const temporal = parseTemporal(text);
  if (!temporal || temporal.kind === 'time') return null;
  if (temporal.kind === 'date') return { lo: temporal.value, hi: temporal.value + FILTER_DAY_MS };
  if (type === 'date') { const day = startOfUtcDay(temporal.value); return { lo: day, hi: day + FILTER_DAY_MS }; }
  return { lo: temporal.value, hi: temporal.value + (/\d{1,2}:\d{2}:\d{2}/.test(text) ? 1000 : 60000) };
}

/** A written number as an interval: [value - half, value + half) for equality (matches the precision it was written with), the exact point otherwise. */
function numericInterval(text: string): Interval | null {
  const magnitude = parseMagnitude(text);
  if (!magnitude) return null;
  const half = 0.5 * 10 ** -magnitude.decimals * magnitude.scale;
  return { lo: magnitude.value - half, hi: magnitude.value + half };
}

function pointOf(interval: Interval): number {
  return (interval.lo + interval.hi) / 2;
}

function compileCondition(token: FilterToken, type: ColType, now: number): Condition | string {
  const text = token.text;
  if (!token.quoted && !token.regex && token.op === '' && text === '?') return { kind: 'empty', neg: token.neg };
  if (type === 'string') {
    if (token.regex) {
      try { return { kind: 'text', mode: 'regex', value: text, re: new RegExp(text, token.flags === '' ? 'i' : token.flags), neg: token.neg }; } catch { return `invalid regular expression /${text}/`; }
    }
    const lower = text.toLowerCase();
    if (token.op === '=' || token.op === '==') return { kind: 'text', mode: 'exact', value: lower, re: null, neg: token.neg };
    if (token.op === '^') return { kind: 'text', mode: 'starts', value: lower, re: null, neg: token.neg };
    if (token.op === '' && !token.quoted && lower.length > 1 && lower.endsWith('$')) return { kind: 'text', mode: 'ends', value: lower.slice(0, -1), re: null, neg: token.neg };
    return { kind: 'text', mode: 'contains', value: token.op + lower, re: null, neg: token.neg };
  }
  const temporal = type === 'date' || type === 'datetime' || type === 'time';
  const literal = (value: string): Interval | null => (temporal ? temporalInterval(value, type, now) : numericInterval(value));
  const range = token.op === '' ? /^(.*?)\.\.(.*)$/.exec(text) : null;
  if (range && (range[1] !== '' || range[2] !== '')) {
    const a = range[1] === '' ? null : literal(range[1]);
    const b = range[2] === '' ? null : literal(range[2]);
    if (range[1] !== '' && !a) return `cannot read "${range[1]}" as ${COL_TYPE_NAMES[type]}`;
    if (range[2] !== '' && !b) return `cannot read "${range[2]}" as ${COL_TYPE_NAMES[type]}`;
    return { kind: 'cmp', op: 'range', a, b, temporal, neg: token.neg };
  }
  const interval = literal(text);
  if (!interval) return `cannot read "${text}" as ${COL_TYPE_NAMES[type]}`;
  const op = token.op === '' || token.op === '==' ? '=' : token.op;
  if (op === '=' || op === '>' || op === '>=' || op === '<' || op === '<=') return { kind: 'cmp', op, a: interval, b: null, temporal, neg: token.neg };
  return `unknown operator "${token.op}"`;
}

function evalCondition(condition: Condition, type: ColType, num: number, text: string): boolean {
  if (condition.kind === 'empty') {
    const empty = type === 'string' ? isEmptyCell(text) : Number.isNaN(num);
    return condition.neg ? !empty : empty;
  }
  if (condition.kind === 'text') {
    let hit: boolean;
    if (condition.mode === 'exact') hit = text === condition.value;
    else if (condition.mode === 'starts') hit = text.startsWith(condition.value);
    else if (condition.mode === 'ends') hit = text.endsWith(condition.value);
    else if (condition.mode === 'regex' && condition.re) hit = condition.re.test(text);
    else hit = text.includes(condition.value);
    return condition.neg ? !hit : hit;
  }
  if (Number.isNaN(num)) return condition.neg;
  const a = condition.a;
  const b = condition.b;
  let hit = false;
  if (condition.op === 'range') {
    hit = (a === null || num >= (condition.temporal ? a.lo : pointOf(a))) && (b === null || (condition.temporal ? num < b.hi : num <= pointOf(b)));
  } else if (a) {
    if (condition.op === '=') hit = num >= a.lo && num < a.hi;
    else if (condition.temporal) hit = condition.op === '>' ? num >= a.hi : condition.op === '>=' ? num >= a.lo : condition.op === '<' ? num < a.lo : num < a.hi;
    else hit = condition.op === '>' ? num > pointOf(a) : condition.op === '>=' ? num >= pointOf(a) : condition.op === '<' ? num < pointOf(a) : num <= pointOf(a);
  }
  return condition.neg ? !hit : hit;
}

/** Compiles a filter expression for a column type. `text` passed to test() must be lower-case; `num` is NaN when unavailable. Null for an empty expression. */
function compileFilter(input: string, type: ColType, now: number = Date.now()): CompiledFilter | null {
  if (input.trim() === '') return null;
  const groups = tokenizeFilter(input);
  if (!groups.length) return null;
  const compiled: Condition[][] = [];
  for (const group of groups) {
    const conditions: Condition[] = [];
    for (const token of group) {
      const condition = compileCondition(token, type, now);
      if (typeof condition === 'string') return { ok: false, error: condition };
      conditions.push(condition);
    }
    compiled.push(conditions);
  }
  return { ok: true, test: (num: number, text: string) => compiled.some(group => group.every(condition => evalCondition(condition, type, num, text))) };
}


// =========================================================================
// 3c. Column filters: state, header badges, the filter row and its events
//     (the expression grammar and the type detection are in 3b above)
// =========================================================================

/**
 * One filterable column of a table. `key` is the sort key of the column header (the key passed to
 * sortHeader), `text` the cell text as the table shows it (also the sample for the type detection),
 * `value` the exact number behind a numeric cell (so a filter compares full precision, not the
 * rounded text) and `extraClass` the classes of a horizontally pinned column.
 */
type FilterColumn = {
  key: string;
  label: string;
  numeric: boolean;
  text: (row: any) => string;
  value?: (row: any) => number | null | undefined;
  extraClass?: string;
};

const FILTER_STORAGE_PREFIX = 'spdr'; // the app's localStorage prefix: the same words that start THEME_KEY
const COLUMN_FILTERS_KEY = `${FILTER_STORAGE_PREFIX}-column-filters`;
const COLUMN_TYPES_KEY = `${FILTER_STORAGE_PREFIX}-column-types`;
const SHOW_FILTERS_KEY = `${FILTER_STORAGE_PREFIX}-show-filters`;
const FILTER_DEBOUNCE_MS = 250;

/** scope (catalog, watchlist, holdings, history, distributions) -> column key -> expression / type chosen with the header badge */
const columnFilterState: { filters: Record<string, Record<string, string>>; typeOverrides: Record<string, Record<string, ColType>>; show: boolean } = { filters: {}, typeOverrides: {}, show: true };

/** What the last render of a scope computed: the columns, the types in use and the detected types (header badges read it). */
const filterInfo: Record<string, { columns: FilterColumn[]; types: ColType[]; detected: ColType[] }> = {};

const filterTimers: Map<string, any> = new Map();
let suppressTableAnimation = false;

function filterStorageGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function filterStorageSet(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* quota or private mode */ }
}

function filterStorageRemove(key: string): void {
  try { localStorage.removeItem(key); } catch { /* blocked storage */ }
}

/** Which set of filters belongs to the shown table; none for the overview and the empty states. */
function currentFilterScope(): string {
  if (state.activeTab === 'watchlist') return 'watchlist';
  if (isEtfCatalogTab(state.activeTab)) return 'catalog';
  const key = detailTabKey(state.activeTab);
  return isDetailTab(state.activeTab) && (key === 'holdings' || key === 'history' || key === 'distributions') ? key : '';
}

function filterExpressionFor(scope: string, key: string): string {
  const map = columnFilterState.filters[scope];
  return map && typeof map[key] === 'string' ? map[key] : '';
}

function typeOverrideFor(scope: string, key: string): ColType | undefined {
  const map = columnFilterState.typeOverrides[scope];
  return map ? map[key] : undefined;
}

/** Signature of a scope's filters and type overrides, for the memoized views. */
function columnFilterSig(scope: string): string {
  return JSON.stringify([columnFilterState.filters[scope] || {}, columnFilterState.typeOverrides[scope] || {}, Math.floor(Date.now() / 86400000)]);
}

/**
 * Applies the column filters of a scope to rows and records the column types for the header. The
 * types are detected from `sample` (the rows before any search or filter), so a filter never changes
 * the type of its own column. A filter whose expression does not parse is ignored (the input shows why).
 */
function applyColumnFilters(scope: string, rows: any[], columns: FilterColumn[], sample: any[] = rows): any[] {
  const detected = columns.map(col => {
    const texts: string[] = [];
    for (let i = 0; i < sample.length && texts.length < TYPE_SAMPLE_SIZE; i++) {
      const text = col.text(sample[i]);
      if (!isEmptyCell(text)) texts.push(text);
    }
    return detectColType(texts);
  });
  const types = columns.map((col, i) => typeOverrideFor(scope, col.key) || detected[i]);
  filterInfo[scope] = { columns, types, detected };
  const active: Array<{ col: FilterColumn; type: ColType; test: (num: number, text: string) => boolean }> = [];
  columns.forEach((col, i) => {
    const expression = filterExpressionFor(scope, col.key);
    if (!expression.trim()) return;
    const compiled = compileFilter(expression, types[i]);
    if (compiled && compiled.ok) active.push({ col, type: types[i], test: compiled.test });
  });
  if (!active.length) return rows;
  return rows.filter(row => active.every(filter => {
    if (filter.type === 'string') return filter.test(NaN, filter.col.text(row).toLowerCase());
    const numeric = filter.type === 'number' || filter.type === 'percent' || filter.type === 'currency';
    if (numeric && filter.col.value) {
      const raw = filter.col.value(row);
      return filter.test(typeof raw === 'number' && Number.isFinite(raw) ? raw : NaN, '');
    }
    return filter.test(parseCellValue(filter.col.text(row), filter.type), '');
  }));
}

/** Columns of a header-driven sheet (holdings, history, distributions): the cells are the row's `col0..colN` strings. */
function sheetFilterColumns(headers: string[], numericHeaders: string[]): FilterColumn[] {
  return headers.map((header, index) => ({
    key: `col${index}`,
    label: header || `Col ${index + 1}`,
    numeric: numericHeaders.includes(header),
    text: (row: any) => String(row[`col${index}`] ?? ''),
  }));
}

function activeFilterCount(scope: string): number {
  const info = filterInfo[scope];
  const keys = info ? info.columns.map(col => col.key) : Object.keys(columnFilterState.filters[scope] || {});
  return keys.filter(key => filterExpressionFor(scope, key).trim() !== '').length;
}

/** Header badge with the column type (auto-detected or set by the user); click cycles the type, Shift+click returns to auto-detection. */
function typeBadgeHtml(scope: string, key: string, type: ColType, detected: ColType): string {
  const overridden = type !== detected;
  const title = `Column type: ${COL_TYPE_NAMES[type]} (${overridden ? 'set by you, detected: ' + COL_TYPE_NAMES[detected] : 'auto-detected'}). Click to cycle the type, Shift+click to return to auto-detection.`;
  return `<button type="button" data-type-col="${escapeHtml(key)}" data-filter-scope="${escapeHtml(scope)}" title="${escapeHtml(title)}" class="type-badge ${COL_TYPE_CLASSES[type]}${overridden ? ' is-override' : ''}">${COL_TYPE_LABELS[type]}</button>`;
}

/** The type badge of a column of the table being rendered (empty for tables without filters). */
function filterBadgeFor(key: string): string {
  const scope = currentFilterScope();
  const info = filterInfo[scope];
  if (!info) return '';
  const index = info.columns.findIndex(col => col.key === key);
  return index < 0 ? '' : typeBadgeHtml(scope, key, info.types[index], info.detected[index]);
}

/** The row of filter inputs under the column headers; a column whose expression does not parse shows the reason in red. */
function filterRowHtml(scope: string, info: { columns: FilterColumn[]; types: ColType[] }, leading: string): string {
  return `<tr class="filter-row">${leading}${info.columns.map((col, i) => {
    const expression = filterExpressionFor(scope, col.key);
    const active = expression.trim() !== '';
    const compiled = active ? compileFilter(expression, info.types[i]) : null;
    const error = compiled && !compiled.ok ? compiled.error : '';
    const help = `${error ? 'Cannot apply this filter: ' + error + '. ' : ''}${COL_TYPE_HELP[info.types[i]]}`;
    return `<th class="filter-cell${col.extraClass ? ' ' + col.extraClass : ''}"><div class="filter-wrap"><input type="text" data-filter-col="${escapeHtml(col.key)}" data-filter-scope="${escapeHtml(scope)}" value="${escapeHtml(expression)}" placeholder="${escapeHtml(COL_TYPE_PLACEHOLDERS[info.types[i]])}" spellcheck="false" autocomplete="off" aria-label="Filter ${escapeHtml(col.label)}" title="${escapeHtml(help)}" class="filter-input${active ? ' is-active' : ''}${error ? ' is-invalid' : ''}" />${active ? `<button type="button" data-clear-filter="${escapeHtml(col.key)}" data-filter-scope="${escapeHtml(scope)}" class="filter-clear" title="Clear this filter" aria-label="Clear the ${escapeHtml(col.label)} filter">✕</button>` : ''}</div></th>`;
  }).join('')}</tr>`;
}

/** Called after a table head is written: adds the filter row for the shown scope (the catalog has the # and Use cells in front). */
function appendFilterRow(): void {
  const scope = currentFilterScope();
  const info = filterInfo[scope];
  if (!info || !columnFilterState.show) return;
  const leading = scope === 'catalog'
    ? '<th class="filter-cell"></th><th class="filter-cell catalog-sticky-col catalog-sticky-use"><div class="flex items-center justify-center gap-1 text-slate-400 dark:text-slate-500 text-[0.65rem] uppercase tracking-wider"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4h18l-7 8v6l-4 2v-8z"/></svg>filter</div></th>'
    : '<th class="filter-cell"></th>';
  el.tableHead.insertAdjacentHTML('beforeend', filterRowHtml(scope, info, leading));
}

function renderFilterControls(): void {
  const button: any = document.getElementById('filters-btn');
  const clear: any = document.getElementById('clear-filters-btn');
  const badge: any = document.getElementById('filters-badge');
  const summary: any = document.getElementById('filters-summary');
  if (!button || !clear || !badge || !summary) return;
  const scope = currentFilterScope();
  const count = scope ? activeFilterCount(scope) : 0;
  button.disabled = !scope;
  button.setAttribute('aria-pressed', String(columnFilterState.show));
  summary.textContent = columnFilterState.show ? 'on' : 'off';
  badge.hidden = count === 0;
  badge.textContent = String(count);
  clear.hidden = count === 0;
}

/** The filter row sticks right below the header row: tell the CSS how tall the first row is. */
function syncHeadHeight(): void {
  const first = el.tableHead.querySelector('tr');
  if (first) el.tableScroll.style.setProperty('--head-h', `${first.getBoundingClientRect().height}px`);
}

/** Re-renders after a filter change and puts the caret back into the filter input that was being edited. */
function rerenderKeepingFilterFocus(): void {
  const active: any = document.activeElement;
  const key = active && active.dataset ? active.dataset.filterCol : undefined;
  const scope = active && active.dataset ? active.dataset.filterScope : undefined;
  const caret = key !== undefined && typeof active.selectionStart === 'number' ? active.selectionStart : 0;
  suppressTableAnimation = true;
  render();
  suppressTableAnimation = false;
  if (key === undefined) return;
  const next: any = [...el.tableHead.querySelectorAll('input[data-filter-col]')].find((node: any) => node.dataset.filterCol === key && node.dataset.filterScope === scope);
  if (next) { next.focus(); try { next.setSelectionRange(caret, caret); } catch { /* not a text input */ } }
}

function persistColumnFilters(): void {
  const clean: Record<string, Record<string, string>> = {};
  Object.keys(columnFilterState.filters).forEach(scope => {
    const map = columnFilterState.filters[scope] || {};
    const keys = Object.keys(map).filter(key => typeof map[key] === 'string' && map[key].trim() !== '');
    if (keys.length) clean[scope] = Object.fromEntries(keys.map(key => [key, map[key]]));
  });
  if (Object.keys(clean).length) filterStorageSet(COLUMN_FILTERS_KEY, JSON.stringify(clean));
  else filterStorageRemove(COLUMN_FILTERS_KEY);
}

function persistColumnTypes(): void {
  const clean: Record<string, Record<string, ColType>> = {};
  Object.keys(columnFilterState.typeOverrides).forEach(scope => { if (Object.keys(columnFilterState.typeOverrides[scope] || {}).length) clean[scope] = columnFilterState.typeOverrides[scope]; });
  if (Object.keys(clean).length) filterStorageSet(COLUMN_TYPES_KEY, JSON.stringify(clean));
  else filterStorageRemove(COLUMN_TYPES_KEY);
}

function restoreColumnFilters(): void {
  const parse = (key: string): any => { try { return JSON.parse(filterStorageGet(key) || '{}') || {}; } catch { return {}; } };
  const saved = parse(COLUMN_FILTERS_KEY);
  const filters: Record<string, Record<string, string>> = {};
  if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
    Object.keys(saved).forEach(scope => {
      const map = saved[scope];
      if (!map || typeof map !== 'object' || Array.isArray(map)) return;
      const clean: Record<string, string> = {};
      Object.keys(map).forEach(key => { if (typeof map[key] === 'string' && map[key].trim() !== '') clean[key] = map[key]; });
      if (Object.keys(clean).length) filters[scope] = clean;
    });
  }
  columnFilterState.filters = filters;
  const savedTypes = parse(COLUMN_TYPES_KEY);
  const overrides: Record<string, Record<string, ColType>> = {};
  if (savedTypes && typeof savedTypes === 'object' && !Array.isArray(savedTypes)) {
    Object.keys(savedTypes).forEach(scope => {
      const map = savedTypes[scope];
      if (!map || typeof map !== 'object' || Array.isArray(map)) return;
      const clean: Record<string, ColType> = {};
      Object.keys(map).forEach(key => { if (ALL_COL_TYPES.includes(map[key])) clean[key] = map[key]; });
      if (Object.keys(clean).length) overrides[scope] = clean;
    });
  }
  columnFilterState.typeOverrides = overrides;
  columnFilterState.show = filterStorageGet(SHOW_FILTERS_KEY) !== 'false';
}

function setFilter(scope: string, key: string, value: string): void {
  const next = { ...(columnFilterState.filters[scope] || {}) };
  if (value.trim() === '') delete next[key];
  else next[key] = value;
  columnFilterState.filters[scope] = next;
  persistColumnFilters();
  rerenderKeepingFilterFocus();
}

/** Typing applies the filter after a short pause (FILTER_DEBOUNCE_MS), also when the input loses focus meanwhile; Enter applies it at once (a re-render on blur would swallow the click on a header). */
function scheduleFilter(scope: string, key: string, value: string): void {
  const id = `${scope}:${key}`;
  const pending = filterTimers.get(id);
  if (pending !== undefined) clearTimeout(pending);
  filterTimers.set(id, setTimeout(() => { filterTimers.delete(id); if (filterExpressionFor(scope, key) !== value) setFilter(scope, key, value); }, FILTER_DEBOUNCE_MS));
}

function flushFilter(scope: string, key: string, value: string): void {
  const id = `${scope}:${key}`;
  const pending = filterTimers.get(id);
  if (pending !== undefined) { clearTimeout(pending); filterTimers.delete(id); }
  if (filterExpressionFor(scope, key) !== value) setFilter(scope, key, value);
}

function clearAllFilters(scope: string): void {
  filterTimers.forEach(timer => clearTimeout(timer));
  filterTimers.clear();
  columnFilterState.filters[scope] = {};
  persistColumnFilters();
  render();
}

/** Header badge click: next type in the cycle; Shift+click returns to auto-detection. */
function cycleColumnType(scope: string, key: string, reset: boolean): void {
  const info = filterInfo[scope];
  const index = info ? info.columns.findIndex(col => col.key === key) : -1;
  const detected: ColType = info && index >= 0 ? info.detected[index] : 'string';
  const current = typeOverrideFor(scope, key) || detected;
  const next = reset ? detected : ALL_COL_TYPES[(ALL_COL_TYPES.indexOf(current) + 1) % ALL_COL_TYPES.length];
  const map = { ...(columnFilterState.typeOverrides[scope] || {}) };
  if (next === detected) delete map[key];
  else map[key] = next;
  columnFilterState.typeOverrides[scope] = map;
  persistColumnTypes();
  render();
}

/** Filter inputs and type badges live in the table header (delegated: the header is rebuilt on every render). */
function bindColumnFilterEvents(): void {
  const filtersBtn: any = document.getElementById('filters-btn');
  const clearBtn: any = document.getElementById('clear-filters-btn');
  if (filtersBtn) {
    filtersBtn.addEventListener('click', () => {
      columnFilterState.show = !columnFilterState.show;
      filterStorageSet(SHOW_FILTERS_KEY, String(columnFilterState.show));
      render();
    });
  }
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      const scope = currentFilterScope();
      if (scope) clearAllFilters(scope);
    });
  }
  el.tableHead.addEventListener('input', (event: any) => {
    const target = event.target;
    if (target && target.dataset && target.dataset.filterCol !== undefined) scheduleFilter(target.dataset.filterScope, target.dataset.filterCol, target.value);
  });
  el.tableHead.addEventListener('keydown', (event: any) => {
    const target = event.target;
    if (!target || !target.dataset || target.dataset.filterCol === undefined) return;
    if (event.key === 'Enter') { event.preventDefault(); flushFilter(target.dataset.filterScope, target.dataset.filterCol, target.value); }
    else if (event.key === 'Escape' && target.value !== '') { event.preventDefault(); event.stopPropagation(); flushFilter(target.dataset.filterScope, target.dataset.filterCol, ''); }
  });
  el.tableHead.addEventListener('click', (event: any) => {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    const clear = target.closest('button[data-clear-filter]');
    if (clear) { event.stopPropagation(); flushFilter(clear.dataset.filterScope, clear.dataset.clearFilter, ''); return; }
    const badge = target.closest('button[data-type-col]');
    if (badge) { event.stopPropagation(); cycleColumnType(badge.dataset.filterScope, badge.dataset.typeCol, Boolean(event.shiftKey)); }
  });
}


// =========================================================================
// 3d. Column filters of this app's tables (the keys are the sort keys of the column headers)
// =========================================================================

const FUND_FILTER_COLUMNS: FilterColumn[] = [
  { key: 'ticker', label: 'Ticker', numeric: false, text: (fund: any) => String((fund.ticker) ?? ''), extraClass: 'catalog-sticky-col catalog-sticky-ticker' },
  { key: 'name', label: 'Fund Name', numeric: false, text: (fund: any) => String((fund.name) ?? '') },
  { key: 'category', label: 'Type', numeric: false, text: (fund: any) => String((categoryLabel(fund.category)) ?? '') },
  { key: 'navValue', label: 'NAV', numeric: true, text: (fund: any) => String((fund.nav || '—') ?? ''), value: (fund: any) => fund.navValue },
  { key: 'aumValue', label: 'Net Assets', numeric: true, text: (fund: any) => String((formatMoney(fund.aumValue)) ?? ''), value: (fund: any) => fund.aumValue },
  { key: 'terValue', label: 'Expense', numeric: true, text: (fund: any) => String((fund.ter || '—') ?? ''), value: (fund: any) => fund.terValue },
  { key: 'dividendYield', label: 'Dividend Yield', numeric: true, text: (fund: any) => String((formatPercent(fund.dividendYield)) ?? ''), value: (fund: any) => fund.dividendYield },
  { key: 'secYield', label: 'SEC Yield', numeric: true, text: (fund: any) => String((formatPercent(fund.secYield)) ?? ''), value: (fund: any) => fund.secYield },
  { key: 'dividendFrequency', label: 'Frequency', numeric: false, text: (fund: any) => String((fund.dividendFrequency || '—') ?? '') },
  { key: 'ytd', label: 'YTD Return', numeric: true, text: (fund: any) => String((formatPercent(fund.ytd)) ?? ''), value: (fund: any) => fund.ytd },
  { key: 'yr1', label: 'TR 1Y', numeric: true, text: (fund: any) => String((formatPercent(fund.yr1)) ?? ''), value: (fund: any) => fund.yr1 },
  { key: 'tr3y', label: 'TR 3Y', numeric: true, text: (fund: any) => String((formatPercent(fund.tr3y)) ?? ''), value: (fund: any) => fund.tr3y },
  { key: 'tr5y', label: 'TR 5Y', numeric: true, text: (fund: any) => String((formatPercent(fund.tr5y)) ?? ''), value: (fund: any) => fund.tr5y },
  { key: 'tr10y', label: 'TR 10Y', numeric: true, text: (fund: any) => String((formatPercent(fund.tr10y)) ?? ''), value: (fund: any) => fund.tr10y },
  { key: 'cagr3y', label: 'CAGR 3Y', numeric: true, text: (fund: any) => String((formatPercent(fund.cagr3y)) ?? ''), value: (fund: any) => fund.cagr3y },
  { key: 'cagr5y', label: 'CAGR 5Y', numeric: true, text: (fund: any) => String((formatPercent(fund.cagr5y)) ?? ''), value: (fund: any) => fund.cagr5y },
  { key: 'cagr10y', label: 'CAGR 10Y', numeric: true, text: (fund: any) => String((formatPercent(fund.cagr10y)) ?? ''), value: (fund: any) => fund.cagr10y },
  { key: 'si', label: 'SI Ann.', numeric: true, text: (fund: any) => String((formatPercent(fund.si)) ?? ''), value: (fund: any) => fund.si },
  { key: 'returnAsOf', label: 'Return As Of', numeric: false, text: (fund: any) => String((fund.returnAsOf || '—') ?? '') },
  { key: 'inceptionDate', label: 'Inception', numeric: false, text: (fund: any) => String((fund.inceptionDate || '—') ?? '') },
  { key: 'holdings', label: 'Holdings', numeric: true, text: (fund: any) => String((formatInteger(fund.holdings)) ?? ''), value: (fund: any) => fund.holdings },
  { key: 'history', label: 'History', numeric: true, text: (fund: any) => String((formatInteger(fund.history)) ?? ''), value: (fund: any) => fund.history },
  { key: 'asOfDate', label: 'As Of', numeric: false, text: (fund: any) => String((fund.asOfDate || '—') ?? '') },
];

const WATCHLIST_FILTER_COLUMNS: FilterColumn[] = [
  { key: 'symbol', label: 'Ticker', numeric: false, text: (row: any) => String(row.symbol ?? ''), extraClass: 'watchlist-sticky-col watchlist-sticky-ticker' },
  { key: 'name', label: 'Name', numeric: false, text: (row: any) => String(row.name ?? '') },
  { key: 'funds', label: 'ETFs', numeric: false, text: (row: any) => (Array.isArray(row.funds) ? row.funds.join(' ') : '') },
  { key: 'fundCount', label: '# ETFs', numeric: true, text: (row: any) => String(row.fundCount ?? ''), value: (row: any) => row.fundCount },
  { key: 'weightSum', label: 'Weight Sum', numeric: true, text: (row: any) => (typeof row.weightSum === 'number' ? `${row.weightSum.toFixed(3)}%` : ''), value: (row: any) => row.weightSum },
  { key: 'maxWeight', label: 'Max Weight', numeric: true, text: (row: any) => (typeof row.maxWeight === 'number' ? `${row.maxWeight.toFixed(3)}%` : ''), value: (row: any) => row.maxWeight },
  { key: 'marketValue', label: 'Market Value', numeric: true, text: (row: any) => (row.marketValue ? formatMoney(row.marketValue) : ''), value: (row: any) => (row.marketValue ? row.marketValue : null) },
  { key: 'sector', label: 'Sector', numeric: false, text: (row: any) => String(row.sector ?? '') },
  { key: 'identifier', label: 'Identifier', numeric: false, text: (row: any) => String(row.identifier ?? '') },
];

/** Catalog rows after the tab, the blacklist, the search and the column filters (no sorting). */
function filteredCatalogFunds(): FundRow[] {
  const base = visibleFunds();
  return applyColumnFilters('catalog', filterRows(base), FUND_FILTER_COLUMNS, base);
}

/** Sheet rows (holdings, history, distributions) as objects with the cells in col0..colN, after the search and the column filters (no sorting). */
function sheetView(scope: string, headers: string[], sourceRows: string[][], numericHeaders: string[]): any[] {
  const all = sourceRows.map((row, sourceIndex) => {
    const cells: Record<string, unknown> = { values: row, searchIndex: row.join(' ').toLowerCase(), rank: sourceIndex };
    headers.forEach((header, index) => { cells[`col${index}`] = row[index] ?? ''; });
    return cells;
  });
  return applyColumnFilters(scope, filterRows(all), sheetFilterColumns(headers, numericHeaders), all);
}

init();

// =========================================================================
// 3. Theme & small helpers
// =========================================================================

function applyTheme(dark: boolean): void {
  document.documentElement.classList.toggle('dark', dark);
  el.themeToggle.textContent = dark ? '☀️' : '🌙';
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
  }[char] || char));
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '' || value.trim() === '-') return null;
  const parsed = Number(value.replace(/[$,%\s,]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function numberCell(value: unknown): string {
  const parsed = numberOrNull(value);
  return parsed === null ? '' : String(parsed);
}

function formatPercent(value: unknown): string {
  const parsed = numberOrNull(value);
  return parsed === null ? '—' : `${parsed.toFixed(2)}%`;
}

function formatDividendFrequency(value: unknown): string {
  const raw = String(value ?? '').trim();
  const normalized = raw.toLowerCase().replace(/[‐‑‒–—]/g, '-').replace(/\s+/g, ' ');
  if (!normalized || normalized === '-') return '00 - None';
  if (normalized === 'monthly') return '01 - Monthly';
  if (normalized === 'quarterly') return '04 - Quarterly';
  if (normalized === 'semi-annual' || normalized === 'semi-annually' || normalized === 'semiannual') return '06 - Semi-annually';
  if (normalized === 'annual' || normalized === 'annually') return '12 - Annually';
  if (normalized === 'none') return '00 - None';
  if (normalized === 'unknown') return '00 - Unknown';
  if (normalized === 'irregular') return '99 - Irregular';
  return raw;
}

function formatInteger(value: unknown): string {
  const parsed = numberOrNull(value);
  return parsed === null || parsed === 0 ? '—' : parsed.toLocaleString('en-US');
}

function formatMoney(value: unknown): string {
  const parsed = numberOrNull(value);
  if (parsed === null) return '—';
  if (Math.abs(parsed) >= 1e12) return `$${(parsed / 1e12).toFixed(2)}T`;
  if (Math.abs(parsed) >= 1e9) return `$${(parsed / 1e9).toFixed(2)}B`;
  if (Math.abs(parsed) >= 1e6) return `$${(parsed / 1e6).toFixed(2)}M`;
  if (Math.abs(parsed) >= 1e3) return `$${(parsed / 1e3).toFixed(2)}K`;
  return `$${parsed.toFixed(2)}`;
}

function sanitizeTicker(value: unknown): string {
  return String(value ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase();
}

function getHeaderTooltip(header: string): string {
  if (!header) return '';
  if (COLUMN_TOOLTIPS[header]) return COLUMN_TOOLTIPS[header];
  const clean = String(header).trim();
  const keys = Object.keys(COLUMN_TOOLTIPS);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (key.toLowerCase() === clean.toLowerCase()) return COLUMN_TOOLTIPS[key];
  }
  return clean;
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // Fall through to the legacy path.
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

function downloadText(text: string, fileName: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function toCsv(rows: string[][]): string {
  return rows
    .map(row => row.map(cell => {
      const value = String(cell ?? '');
      return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
    }).join(','))
    .join('\n');
}

function exportFileName(scope: string, extension: string): string {
  const stamp = new Date().toISOString().slice(0, 10);
  return `spdr-${scope.toLowerCase().replace(/\s+/g, '-')}-${stamp}.${extension}`;
}

function setStatus(message: string, tone: 'info' | 'success' | 'error'): void {
  console.debug(`[${tone}] ${message}`);
}

// =========================================================================
// 4. Static API loading & paginated sheets (api/spdr/**, iShares-style)
// =========================================================================

async function fetchJson(url: string): Promise<any> {
  const response = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-cache' });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

/** Flattens index.json month-end metrics onto the row so sorting works. */
function normalizeFundRow(fund: IndexFund): FundRow {
  const monthEnd = (fund.returns && fund.returns.monthEnd) || {};
  const metrics = fund.metrics || {};
  const row: any = {
    ...fund,
    ytd: monthEnd.ytd ?? null,
    yr1: metrics.tr1y ?? monthEnd.yr1 ?? null,
    yr3: monthEnd.yr3 ?? null,
    yr5: monthEnd.yr5 ?? null,
    yr10: monthEnd.yr10 ?? null,
    si: metrics.siAnn ?? monthEnd.sinceInception ?? null,
    tr3y: metrics.tr3y ?? null,
    tr5y: metrics.tr5y ?? null,
    tr10y: metrics.tr10y ?? null,
    cagr3y: metrics.cagr3y ?? monthEnd.yr3 ?? null,
    cagr5y: metrics.cagr5y ?? monthEnd.yr5 ?? null,
    cagr10y: metrics.cagr10y ?? monthEnd.yr10 ?? null,
    dividendYield: metrics.dividendYield ?? null,
    dividendFrequency: formatDividendFrequency(fund.distributions && fund.distributions.frequency ? fund.distributions.frequency : '—'),
    // Official SSGA 30-day SEC yield, from the bulk product-data workbook (spdr-product-data-us-en.xlsx).
    secYield: metrics.secYield ?? null,
    returnAsOf: monthEnd.asOfDate ?? null,
    searchIndex: '',
  };
  row.searchIndex = [
    fund.ticker, fund.name, fund.category, fund.ter, fund.nav, fund.aum,
    fund.exchange, fund.inceptionDate, fund.asOfDate, monthEnd.asOfDate,
    fund.distributions && fund.distributions.frequency, metrics.dividendYieldText,
  ].map(value => String(value ?? '').toLowerCase()).join(' ');
  return row;
}

async function loadCatalog(): Promise<void> {
  setStatus('Loading SPDR ETF data from api/spdr/index.json…', 'info');
  const data = await fetchJson(INDEX_URL);
  state.funds = (data.funds || [])
    .map((fund: IndexFund) => normalizeFundRow(fund))
    .sort((a: FundRow, b: FundRow) => a.ticker.localeCompare(b.ticker));
  state.generatedAt = data.generatedAt || null;
  state.counts = data.counts || null;

  // A restored selection/blacklist must reference known funds only.
  state.blacklist = new Set([...state.blacklist].filter(ticker => state.funds.some(fund => fund.ticker === ticker)));
  state.selected = new Set([...state.selected].filter(ticker => state.funds.some(fund => fund.ticker === ticker) && !state.blacklist.has(ticker)));
  if (!state.activeFundTicker && state.selected.size) state.activeFundTicker = [...state.selected][0] || null;
  if (state.activeFundTicker && !state.selected.has(state.activeFundTicker)) {
    state.activeFundTicker = [...state.selected][0] || null;
  }

  el.searchInput.disabled = false;
  [el.copyBtn, el.exportCsvBtn, el.exportTxtBtn, el.resetBtn].forEach(button => { button.disabled = false; });
  applyRestoredTab();
  applySortForTab(state.activeTab);
  render();
  void ensureHoldingsForSelection();
  const activeTicker = state.activeFundTicker;
  if (activeTicker) {
    void loadFundMeta(activeTicker).then(meta => {
      if (meta && state.activeFundTicker === activeTicker && state.activeTab === 'detail:holdings') void ensureSheet('holdings', meta.holdings);
    });
  }
}

async function loadFundMeta(ticker: string): Promise<any> {
  if (fundMetaCache.has(ticker)) return fundMetaCache.get(ticker);
  const pending = fundMetaRequests.get(ticker);
  if (pending) return pending;

  const known = state.funds.find(fund => fund.ticker === ticker);
  if (known && !known.holdings && !known.history) {
    // Catalog-only funds (for example commodity trusts) have no workbook and
    // therefore no funds/<ticker>/meta.json in the generated static feed.
    fundMetaCache.set(ticker, null);
    return null;
  }

  const request = (async () => {
    try {
      const meta = await fetchJson(`./api/spdr/funds/${encodeURIComponent(ticker)}/meta.json`);
      fundMetaCache.set(ticker, meta);
      fundMetaFailures.delete(ticker);
      scheduleSelectionDataRefresh(ticker);
      return meta;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      fundMetaFailures.set(ticker, message);
      console.warn(`Failed to load meta.json for ${ticker}:`, error);
      return null;
    }
  })();
  fundMetaRequests.set(ticker, request);
  try {
    return await request;
  } finally {
    if (fundMetaRequests.get(ticker) === request) fundMetaRequests.delete(ticker);
  }
}

function sheetKey(sheet: string): string {
  return `${state.activeFundTicker}:${sheet}`;
}

function resetSheetPaging(): void {
  sheetGeneration += 1;
}

async function fetchPage(ticker: string, pagePath: string): Promise<{ headers: string[]; rows: string[][] }> {
  const path = String(pagePath).replace(/^\.?\//, '');
  const page = await fetchJson(`./api/spdr/funds/${encodeURIComponent(ticker)}/${path}`);
  const headers: string[] = Array.isArray(page.headers) ? page.headers : [];
  const rows: any[] = Array.isArray(page.rows) ? page.rows : [];
  return { headers, rows: rowsForStaticHeaders(headers, rows) };
}

/** Loads the first page of a paginated sheet and prepares lazy appending. */
async function ensureSheet(sheet: 'holdings' | 'history', manifest: any): Promise<void> {
  const ticker = state.activeFundTicker;
  if (!ticker || !manifest || !Array.isArray(manifest.pages) || !manifest.pages.length) return;
  const key = `${ticker}:${sheet}`;
  let entry = sheetState.get(key);
  if (!entry) {
    entry = { headers: [], rows: [], nextPage: 0, manifest, loading: false };
    sheetState.set(key, entry);
  } else {
    entry.manifest = manifest;
  }
  if (entry.nextPage < entry.manifest.pages.length) await loadNextSheetPage(sheet);
}

/**
 * Loads one detail-sheet page. A per-sheet promise prevents scroll, sentinel
 * and background-Watchlist requests from fetching the same page concurrently.
 */
async function loadNextSheetPage(sheet: 'holdings' | 'history'): Promise<void> {
  const ticker = state.activeFundTicker;
  if (!ticker) return;
  const key = `${ticker}:${sheet}`;

  // Selection preloading owns the holdings entry while it is filling every
  // page for Watchlist aggregation. Reuse that work instead of racing it.
  const fullHoldingsLoad = sheet === 'holdings' ? holdingsLoadPromises.get(ticker) : null;
  if (fullHoldingsLoad) {
    await fullHoldingsLoad;
    return;
  }

  const pending = sheetPageRequests.get(key);
  if (pending) return pending;
  const entry = sheetState.get(key);
  if (!entry || entry.nextPage >= entry.manifest.pages.length) return;

  const request = (async () => {
    entry.loading = true;
    renderStaticLoadSentinel();
    try {
      const generation = sheetGeneration;
      const pageIndex = entry.nextPage;
      const page = await fetchPage(ticker, entry.manifest.pages[pageIndex]);
      if (generation !== sheetGeneration) return;
      if (!entry.headers.length && page.headers.length) entry.headers = page.headers;
      entry.rows = entry.rows.concat(page.rows);
      entry.nextPage = pageIndex + 1;
      sheetLoadFailures.delete(key);
      if (sheet === 'holdings') {
        invalidateWatchlistRows();
        scheduleSelectionDataRefresh(ticker);
      }
      if (state.activeFundTicker === ticker && state.activeTab === `detail:${sheet}`) render();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sheetLoadFailures.set(key, message);
      console.error(`Failed to load ${ticker} ${sheet} page:`, error);
    } finally {
      entry.loading = false;
      renderStaticLoadSentinel();
    }
  })();
  sheetPageRequests.set(key, request);
  try {
    await request;
  } finally {
    if (sheetPageRequests.get(key) === request) sheetPageRequests.delete(key);
  }
}

async function acquireHoldingsLoadSlot(): Promise<void> {
  if (activeHoldingsLoads < MAX_CONCURRENT_HOLDINGS_LOADS) {
    activeHoldingsLoads += 1;
    return;
  }
  // releaseHoldingsLoadSlot transfers an occupied slot directly to this
  // waiter, so there is no decrement/increment race between microtasks.
  await new Promise<void>(resolve => holdingsLoadWaiters.push(resolve));
}

function releaseHoldingsLoadSlot(): void {
  const next = holdingsLoadWaiters.shift();
  if (next) next();
  else activeHoldingsLoads = Math.max(0, activeHoldingsLoads - 1);
}

function holdingsEntryIsComplete(entry: SheetEntry | undefined): boolean {
  return Boolean(entry && entry.manifest && Array.isArray(entry.manifest.pages) && entry.nextPage >= entry.manifest.pages.length);
}

/** Loads every holdings page for one selected ETF, exactly once at a time. */
function ensureAllHoldingsForTicker(ticker: string): Promise<void> {
  const key = `${ticker}:holdings`;
  if (holdingsEntryIsComplete(sheetState.get(key))) return Promise.resolve();
  const pending = holdingsLoadPromises.get(ticker);
  if (pending) return pending;

  const request = (async () => {
    await acquireHoldingsLoadSlot();
    try {
      // A queued all-catalog request can become obsolete while it waits (for
      // example, the user immediately unchecks some ETFs). Do no wasted I/O.
      if (!state.selected.has(ticker)) return;
      holdingsLoadFailures.delete(ticker);
      const meta = await loadFundMeta(ticker);
      if (!state.selected.has(ticker)) return;
      const manifest = meta && meta.holdings;
      if (!manifest || !Array.isArray(manifest.pages) || !manifest.pages.length) {
        const known = state.funds.find(fund => fund.ticker === ticker);
        if (known && known.holdings > 0) holdingsLoadFailures.add(ticker);
        return;
      }

      // If the detail-view loader got here first, let its page finish before
      // taking ownership of this same cache entry.
      const detailPageRequest = sheetPageRequests.get(key);
      if (detailPageRequest) await detailPageRequest;

      let entry = sheetState.get(key);
      if (!entry) {
        entry = { headers: [], rows: [], nextPage: 0, manifest, loading: false };
        sheetState.set(key, entry);
      } else {
        entry.manifest = manifest;
      }
      entry.loading = true;
      while (entry.nextPage < manifest.pages.length && state.selected.has(ticker)) {
        const pageIndex = entry.nextPage;
        const page = await fetchPage(ticker, manifest.pages[pageIndex]);
        if (!entry.headers.length && page.headers.length) entry.headers = page.headers;
        entry.rows = entry.rows.concat(page.rows);
        entry.nextPage = pageIndex + 1;
        sheetLoadFailures.delete(key);
        invalidateWatchlistRows();
        scheduleSelectionDataRefresh(ticker);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      holdingsLoadFailures.add(ticker);
      sheetLoadFailures.set(key, message);
      console.error(`Failed to preload ${ticker} holdings:`, error);
    } finally {
      const entry = sheetState.get(key);
      if (entry) entry.loading = false;
      releaseHoldingsLoadSlot();
    }
  })();

  holdingsLoadPromises.set(ticker, request);
  void request.finally(() => {
    if (holdingsLoadPromises.get(ticker) === request) holdingsLoadPromises.delete(ticker);
    scheduleSelectionDataRefresh(ticker);
    // Close the narrow uncheck/recheck race: a reselect can reuse a promise
    // that was just about to stop because the ticker was momentarily absent.
    if (state.selected.has(ticker) && !holdingsEntryIsComplete(sheetState.get(key)) && !holdingsLoadFailures.has(ticker)) {
      void ensureAllHoldingsForTicker(ticker);
    }
  });
  return request;
}

/**
 * Watchlist aggregation needs every holdings page of every selected ETF.
 * Per-ticker promise deduplication and bounded concurrency avoid duplicate /
 * skipped pages when checkboxes change quickly and avoid a 180-request burst
 * when the All ETFs pill is checked.
 */
async function ensureHoldingsForSelection(): Promise<void> {
  const tickers = [...state.selected].filter(ticker => {
    const fund = state.funds.find(candidate => candidate.ticker === ticker);
    return Boolean(fund && fund.holdings > 0);
  });
  await Promise.all(tickers.map(ticker => ensureAllHoldingsForTicker(ticker)));
  scheduleSelectionDataRefresh();
}

function activeSheetTab(): 'holdings' | 'history' | null {
  if (state.activeTab === 'detail:holdings') return 'holdings';
  if (state.activeTab === 'detail:history') return 'history';
  return null;
}

function maybeLoadMoreRows(): void {
  if (state.activeTab === 'watchlist') {
    if (watchlistVisibleLimit < renderedWatchlistTotal) {
      watchlistVisibleLimit += WATCHLIST_PAGE_SIZE;
      renderWatchlistTable();
      fitTableHeight();
      renderStaticLoadSentinel();
    }
    return;
  }
  const sheet = activeSheetTab();
  if (!sheet) return;
  void loadNextSheetPage(sheet);
}

function renderStaticLoadSentinel(): void {
  if (state.activeTab === 'watchlist') {
    const progress = selectedHoldingsLoadState();
    const shown = Math.min(watchlistVisibleLimit, renderedWatchlistTotal);
    const moreRows = shown < renderedWatchlistTotal;
    const show = moreRows || progress.loading;
    el.staticLoadSentinel.classList.toggle('hidden', !show);
    el.staticLoadStatus.textContent = moreRows
      ? `Showing ${shown.toLocaleString('en-US')} of ${renderedWatchlistTotal.toLocaleString('en-US')} holdings — scroll or click to load more…`
      : progress.loading
        ? `Loading holdings… ${progress.completeFunds} of ${progress.sourceFunds} selected ETF files ready.`
        : '';
    return;
  }

  const sheet = activeSheetTab();
  if (!sheet || !state.activeFundTicker) {
    el.staticLoadSentinel.classList.add('hidden');
    return;
  }
  const entry = sheetState.get(sheetKey(sheet));
  if (!entry) {
    el.staticLoadSentinel.classList.add('hidden');
    return;
  }
  const more = entry.nextPage < entry.manifest.pages.length;
  el.staticLoadSentinel.classList.toggle('hidden', !more);
  el.staticLoadStatus.textContent = entry.loading ? 'Loading more rows…' : more ? 'Scroll or click to load more rows…' : '';
}

// =========================================================================
// 5. Navigation tabs & tab switching
// =========================================================================

function categoryLabel(category: string): string {
  return category || 'ETF';
}

function uniqueCategories(): string[] {
  const categories = [...new Set(state.funds.map(fund => fund.category).filter(Boolean))];
  return categories.sort((a, b) => b.length - a.length || a.localeCompare(b));
}

function visibleFunds(): FundRow[] {
  const tab = isEtfCatalogTab(state.activeTab) ? state.activeTab : 'All';
  return state.funds.filter(fund => (tab === 'All' || fund.category === tab) && !state.blacklist.has(fund.ticker));
}

function getTabs(): TabInfo[] {
  const tabs: TabInfo[] = [];
  tabs.push({ id: 'All', label: 'All ETFs', count: state.funds.filter(fund => !state.blacklist.has(fund.ticker)).length });
  uniqueCategories().forEach(category => {
    tabs.push({
      id: category,
      label: categoryLabel(category),
      count: state.funds.filter(fund => fund.category === category && !state.blacklist.has(fund.ticker)).length,
    });
  });
  return tabs;
}

type SelectedHoldingsLoadState = {
  sourceFunds: number;
  completeFunds: number;
  failedFunds: number;
  loading: boolean;
};

function selectedHoldingsLoadState(): SelectedHoldingsLoadState {
  const sourceTickers = [...state.selected].filter(ticker => {
    const fund = state.funds.find(candidate => candidate.ticker === ticker);
    return Boolean(fund && fund.holdings > 0);
  });
  const completeFunds = sourceTickers.filter(ticker => holdingsEntryIsComplete(sheetState.get(`${ticker}:holdings`))).length;
  const failedFunds = sourceTickers.filter(ticker => holdingsLoadFailures.has(ticker)).length;
  return {
    sourceFunds: sourceTickers.length,
    completeFunds,
    failedFunds,
    loading: completeFunds + failedFunds < sourceTickers.length,
  };
}

function getSelectedTabs(): TabInfo[] {
  const tabs: TabInfo[] = [];
  const activeFund = getActiveFund();

  if (activeFund) {
    DETAIL_TABS.forEach(tab => {
      tabs.push({
        id: `detail:${tab.key}`,
        label: tab.key === 'overview' ? `${activeFund.ticker} ${tab.label}` : tab.label,
        count: getDetailCount(tab.key),
      });
    });
  }

  // Keep Watchlist visible while it is the active view even if the selection
  // just became empty (All ETFs pill uncheck must not navigate away).
  if (state.selected.size > 0 || state.activeTab === 'watchlist') {
    const progress = selectedHoldingsLoadState();
    tabs.push({
      id: 'watchlist',
      label: 'Watchlist',
      count: getDedupedWatchlistRows().length,
      loading: progress.loading,
      failed: progress.failedFunds > 0,
    });
  }

  return tabs;
}

function getAllTabIds(): ActiveTab[] {
  return [...getTabs(), ...getSelectedTabs()].map(tab => tab.id);
}

function getActiveFund(): FundRow | null {
  if (!state.activeFundTicker || !state.selected.has(state.activeFundTicker)) return null;
  return state.funds.find(fund => fund.ticker === state.activeFundTicker) || null;
}

function getDetailCount(key: string): number {
  const activeFund = getActiveFund();
  if (!activeFund) return 0;
  if (key === 'holdings') return activeFund.holdings || 0;
  if (key === 'history') return activeFund.history || 0;
  if (key === 'distributions') {
    const meta = fundMetaCache.get(activeFund.ticker);
    if (meta && meta.distributions && Array.isArray(meta.distributions.rows)) return meta.distributions.rows.length;
    const summary = activeFund.distributions || { frequency: '', exDate: '', dividend: '' };
    return [summary.frequency, summary.exDate, summary.dividend].some(value => String(value || '').trim() !== '' && value !== '-') ? 1 : 0;
  }
  return 0;
}

function ensureValidTab(): void {
  const tabIds = getAllTabIds();
  if (!tabIds.includes(state.activeTab)) {
    state.activeTab = 'All';
    applySortForTab(state.activeTab);
  }
}

function applyRestoredTab(): void {
  const tabIds = getAllTabIds();
  if (!tabIds.includes(state.activeTab)) state.activeTab = 'All';
  applySortForTab(state.activeTab);
  syncSearchInput();
}

/**
 * Switch the active view. Saves the outgoing tab's search query (never when
 * the destination equals the current tab, e.g. boot before DOM hydration)
 * and restores the destination tab's remembered query and sort.
 */
function switchTab(tab: ActiveTab): void {
  if (state.activeTab && state.activeTab !== tab) {
    const curVal = el.searchInput.value;
    if (curVal && curVal.length > 0) state.queryByTab[state.activeTab] = curVal;
    else delete state.queryByTab[state.activeTab];
    persistTabFilters();
  }

  state.activeTab = tab;
  applySortForTab(tab);
  resetSheetPaging();
  if (tab === 'watchlist') {
    watchlistVisibleLimit = WATCHLIST_PAGE_SIZE;
    void ensureHoldingsForSelection();
  }
  el.searchInput.value = state.queryByTab[tab] || '';
  updateSearchClearBtn();
  persistSiteState();
  render();
  // Watchlist already painted its first 250-row chunk; extra pages load on
  // scroll. Detail sheets still need a kick to fetch the next page.
  if (tab !== 'watchlist') maybeLoadMoreRows();
}

function renderTabs(): void {
  renderTabButtons(el.tabsBar, getTabs());
  const selectedTabs = getSelectedTabs();
  el.selectedTabsPanel.classList.toggle('is-visible', selectedTabs.length > 0);
  renderTabButtons(el.selectedTabsBar, selectedTabs);
}

function renderTabButtons(container: any, tabs: TabInfo[]): void {
  container.classList.toggle('hidden', tabs.length <= 1);
  // The pill box covers the whole catalog (it sits next to the "All ETFs (N)"
  // count), so its checked state ignores the current tab and search filter.
  const nonBlacklisted = state.funds.filter(fund => !state.blacklist.has(fund.ticker));
  const allSelected = nonBlacklisted.length > 0 && nonBlacklisted.every(fund => state.selected.has(fund.ticker));
  container.innerHTML = tabs.map(tab => {
    const isActive = tab.id === state.activeTab;
    const activeClasses = 'bg-blue-600 text-white font-medium border-blue-500 shadow-sm';
    const inactiveClasses = 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-200 dark:hover:bg-slate-700 border-slate-200 dark:border-slate-700';
    const countText = tab.loading
      ? (tab.count > 0 ? `${tab.count.toLocaleString('en-US')}+` : 'Loading…')
      : `${tab.count.toLocaleString('en-US')}${tab.failed ? ' ⚠' : ''}`;
    if (tab.id === 'All') {
      return `
        <div class="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs transition border whitespace-nowrap ${isActive ? activeClasses : inactiveClasses}">
          <input type="checkbox" id="select-all-toggle" ${allSelected ? 'checked' : ''} class="w-3.5 h-3.5 accent-blue-600 cursor-pointer" title="Select / Deselect all ETFs" />
          <button id="all-etfs-tab-btn" data-tab="All" class="font-medium hover:underline focus:outline-none">
            ${escapeHtml(tab.label)} (${escapeHtml(countText)})
          </button>
        </div>
      `;
    }
    return `
      <button
        data-tab="${escapeHtml(tab.id)}"
        class="px-3.5 py-1.5 rounded-full text-xs transition border whitespace-nowrap ${isActive ? activeClasses : inactiveClasses}">
        ${escapeHtml(tab.label)} (${escapeHtml(countText)})
      </button>
    `;
  }).join('');

  container.querySelectorAll('button[data-tab]').forEach((button: any) => {
    button.addEventListener('click', () => {
      switchTab(button.dataset.tab || 'All');
    });
  });

  const selectAllToggle = container.querySelector('#select-all-toggle');
  if (selectAllToggle) {
    selectAllToggle.addEventListener('change', (event: any) => {
      event.stopPropagation();
      // 'catalog': the pill box keeps whole-catalog semantics — it selects or
      // deselects every non-blacklisted ETF, regardless of tab or filter.
      toggleSelectAll(Boolean(event.target.checked), 'catalog');
    });
    selectAllToggle.addEventListener('click', (event: any) => event.stopPropagation());
  }
}

function applyDefaultSortForTab(tab: ActiveTab): void {
  if (tab === 'watchlist') {
    state.sortKey = 'weightSum';
    state.sortDir = 'desc';
  } else if (tab === 'detail:overview') {
    state.sortKey = 'section';
    state.sortDir = 'asc';
  } else {
    // Holdings, History and Distributions arrive already ordered by the
    // source workbook (weight / date); keep the source order by default.
    state.sortKey = 'rank';
    state.sortDir = 'asc';
  }
}

/**
 * Restores the sort the user last chose on this tab (recorded on every
 * column-header click, persisted in localStorage) or falls back to the tab
 * default when the tab was never explicitly sorted.
 */
function applySortForTab(tab: ActiveTab): void {
  const remembered = state.sortByTab[tab];
  if (remembered) {
    state.sortKey = remembered.key;
    state.sortDir = remembered.dir;
    return;
  }
  applyDefaultSortForTab(tab);
}

/** Records the current sort as this tab's remembered sort. */
function rememberSortForCurrentTab(): void {
  state.sortByTab[state.activeTab] = { key: state.sortKey, dir: state.sortDir };
  persistTabSorts();
}

function tabLabel(tab: ActiveTab): string {
  const match = /^detail:(.+)$/.exec(tab);
  if (match) {
    const found = DETAIL_TABS.find(item => item.key === match[1]);
    return found ? found.label : tab;
  }
  return tab === 'watchlist' ? 'Watchlist' : categoryLabel(tab);
}

function isEtfCatalogTab(tab: ActiveTab): boolean {
  return tab === 'All' || uniqueCategories().includes(tab);
}

function isDetailTab(tab: ActiveTab): boolean {
  return /^detail:(overview|holdings|history|distributions)$/.test(tab);
}

function detailTabKey(tab: ActiveTab): string {
  const match = /^detail:(.+)$/.exec(tab);
  return match ? match[1] : 'overview';
}

// =========================================================================
// 6. Table rendering, sorting & tooltips
// =========================================================================

function render(): void {
  ensureValidTab();
  renderTabs();
  renderBlacklistPanel();
  animateTableUpdate();
  if (state.activeTab === 'watchlist') renderWatchlistTable();
  else if (isDetailTab(state.activeTab)) renderDetailTable(detailTabKey(state.activeTab));
  else renderFundsTable();
  fitTableHeight();
  renderStaticLoadSentinel();
  renderFilterControls();
  syncHeadHeight();
}

function animateTableUpdate(): void {
  if (suppressTableAnimation) return;
  el.tableBody.classList.remove('table-content-enter');
  void el.tableBody.offsetWidth; // reflow to restart the animation
  el.tableBody.classList.add('table-content-enter');
}

function currentQuery(): string {
  return state.queryByTab[state.activeTab] || '';
}

function setCurrentQuery(value: string): void {
  if (value) state.queryByTab[state.activeTab] = value;
  else delete state.queryByTab[state.activeTab];
  persistTabFilters();
  persistSiteState();
}

function updateSearchClearBtn(): void {
  if (!el.searchClearBtn) return;
  el.searchClearBtn.classList.toggle('hidden', !el.searchInput.value);
}

function syncSearchInput(): void {
  const query = currentQuery();
  if (document.activeElement !== el.searchInput && el.searchInput.value !== query) {
    el.searchInput.value = query;
  }
  el.searchInput.placeholder = isEtfCatalogTab(state.activeTab)
    ? 'Search ETFs, fund names, holdings, tickers, CUSIPs/ISINs, SEDOLs...'
    : `Search ${tabLabel(state.activeTab)}...`;
  updateSearchClearBtn();
}

function clearActiveSearchFilter(): void {
  el.searchInput.value = '';
  delete state.queryByTab[state.activeTab];
  persistTabFilters();
  persistSiteState();
  updateSearchClearBtn();
  el.searchInput.focus?.();
  if (state.activeTab === 'watchlist') watchlistVisibleLimit = WATCHLIST_PAGE_SIZE;
  render();
}

function filterRows(rows: any[]): any[] {
  const query = normalizeSearchText(currentQuery());
  if (!query) return rows;
  return rows.filter(row => String(row.searchIndex || '').includes(query));
}

function sortValue(row: Record<string, unknown>, key: string): unknown {
  return row[key];
}

function compareValues(a: unknown, b: unknown): number {
  const an = numberOrNull(a);
  const bn = numberOrNull(b);
  if (an !== null && bn !== null) return an - bn;
  const as = String(a ?? '');
  const bs = String(b ?? '');
  // SSGA NAV history dates ("21-Aug-2026") sort chronologically.
  if (/^\d{1,2}-[A-Za-z]{3}-\d{4}$/.test(as) || /^\d{1,2}-[A-Za-z]{3}-\d{4}$/.test(bs)) {
    const ad = Date.parse(as.replace(/-/g, ' '));
    const bd = Date.parse(bs.replace(/-/g, ' '));
    if (!Number.isNaN(ad) && !Number.isNaN(bd)) return ad - bd;
  }
  return as.localeCompare(bs, undefined, { numeric: true });
}

function sortRows(rows: any[]): any[] {
  if (state.sortKey === 'rank') return rows;
  const direction = state.sortDir === 'asc' ? 1 : -1;
  const key = state.sortKey;
  return [...rows].sort((a, b) => compareValues(sortValue(a, key), sortValue(b, key)) * direction);
}

function sortHeader(label: string, key: string, numeric = false, explicitStickyClass = ''): string {
  const active = state.sortKey === key;
  const arrow = active ? (state.sortDir === 'asc' ? ' ↑' : ' ↓') : '';
  const align = numeric ? ' text-right' : '';
  const tooltip = getHeaderTooltip(label);
  const button = `<button data-sort="${escapeHtml(key)}" title="${escapeHtml(tooltip)}" class="uppercase tracking-wider hover:text-blue-600 dark:hover:text-blue-400 focus:outline-none focus:text-blue-600 dark:focus:text-blue-400">${escapeHtml(label)}${arrow}</button>`;
  const stickyClass = explicitStickyClass || (key === 'ticker' ? ' catalog-sticky-col catalog-sticky-ticker' : '');
  return `<th class="py-3.5 px-4${align}${stickyClass}" title="${escapeHtml(tooltip)}"><div class="flex items-center gap-1.5${numeric ? ' justify-end' : ''}">${button}${filterBadgeFor(key)}</div></th>`;
}

/**
 * The rows the catalog table actually renders: catalog tab + active search
 * filter + blacklist exclusion + column filters (the scope of the header Use
 * checkbox and of select-all).
 */
function visibleCatalogRows(): FundRow[] {
  return filteredCatalogFunds();
}

function indexHeader(): string {
  return `<th class="py-3.5 px-4 w-12 text-center" title="${escapeHtml(getHeaderTooltip('#'))}">#</th>`;
}

function useHeader(): string {
  // The checked state tracks exactly the rows the table currently renders
  // (current tab + active search filter), the same set select-all toggles.
  const rows = visibleCatalogRows();
  const allSelected = rows.length > 0 && rows.every(fund => state.selected.has(fund.ticker));
  return `<th class="catalog-sticky-col catalog-sticky-use py-3.5 px-4 w-20 text-center" title="${escapeHtml(getHeaderTooltip('Use'))}">
    <span class="inline-flex items-center justify-center gap-1">
      <input type="checkbox" id="select-all-checkbox" ${allSelected ? 'checked' : ''} class="w-4 h-4 accent-blue-600 cursor-pointer" title="Select / Deselect all visible ETFs (current tab + search filter)" />
      <span>Use</span>
    </span>
  </th>`;
}

function bindSortHeaders(): void {
  appendFilterRow();
  el.tableHead.querySelectorAll('button[data-sort]').forEach((button: any) => {
    button.addEventListener('click', () => {
      const key = button.dataset.sort || 'rank';
      if (state.sortKey === key) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      else {
        state.sortKey = key;
        state.sortDir = ['ticker', 'name', 'category', 'symbol', 'section', 'metric', 'identifier', 'label'].includes(key) ? 'asc' : 'desc';
      }
      rememberSortForCurrentTab();
      if (state.activeTab === 'watchlist') watchlistVisibleLimit = WATCHLIST_PAGE_SIZE;
      render();
    });
  });
}

function bindSelectAllCheckbox(): void {
  const checkbox = el.tableHead.querySelector('#select-all-checkbox');
  if (!checkbox) return;
  checkbox.addEventListener('change', (event: any) => {
    event.stopPropagation();
    // 'visible': the header box manages only the rows currently rendered
    // (current tab + active search filter), never the hidden ones.
    toggleSelectAll(Boolean(event.target.checked), 'visible');
  });
  checkbox.addEventListener('click', (event: any) => event.stopPropagation());
}

function renderFundsTable(): void {
  const rows = sortRows(filteredCatalogFunds());
  el.tableHead.innerHTML = `
    <tr>
      ${indexHeader()}
      ${useHeader()}
      ${sortHeader('Ticker', 'ticker')}
      ${sortHeader('Fund Name', 'name')}
      ${sortHeader('Type', 'category')}
      ${sortHeader('NAV', 'navValue', true)}
      ${sortHeader('Net Assets', 'aumValue', true)}
      ${sortHeader('Expense', 'terValue', true)}
      ${sortHeader('Dividend Yield', 'dividendYield', true)}
      ${sortHeader('SEC Yield', 'secYield', true)}
      ${sortHeader('Frequency', 'dividendFrequency')}
      ${sortHeader('YTD Return', 'ytd', true)}
      ${sortHeader('TR 1Y', 'yr1', true)}
      ${sortHeader('TR 3Y', 'tr3y', true)}
      ${sortHeader('TR 5Y', 'tr5y', true)}
      ${sortHeader('TR 10Y', 'tr10y', true)}
      ${sortHeader('CAGR 3Y', 'cagr3y', true)}
      ${sortHeader('CAGR 5Y', 'cagr5y', true)}
      ${sortHeader('CAGR 10Y', 'cagr10y', true)}
      ${sortHeader('SI Ann.', 'si', true)}
      ${sortHeader('Return As Of', 'returnAsOf')}
      ${sortHeader('Inception', 'inceptionDate')}
      ${sortHeader('Holdings', 'holdings', true)}
      ${sortHeader('History', 'history', true)}
      ${sortHeader('As Of', 'asOfDate')}
    </tr>
  `;
  bindSortHeaders();
  bindSelectAllCheckbox();

  if (!rows.length) {
    el.tableBody.innerHTML = `<tr><td colspan="25" class="py-12 text-center text-slate-400 dark:text-slate-500">No ETFs match your search.</td></tr>`;
  } else {
    el.tableBody.innerHTML = rows.map((fund, index) => {
      const selected = state.selected.has(fund.ticker);
      return `
        <tr data-ticker="${escapeHtml(fund.ticker)}" class="hover:bg-slate-50 dark:hover:bg-slate-700/30 transition border-b border-slate-100 dark:border-slate-700/30 ${selected ? 'selected-row' : ''}">
          <td class="py-2.5 px-4 text-slate-400 dark:text-slate-500 text-xs text-center font-mono">${index + 1}</td>
          <td class="catalog-sticky-col catalog-sticky-use py-2.5 px-4 text-center">
            <span class="inline-flex items-center justify-center gap-1.5">
              <input data-checkbox="${escapeHtml(fund.ticker)}" type="checkbox" ${selected ? 'checked' : ''} class="w-4 h-4 accent-blue-600 cursor-pointer" aria-label="Use ${escapeHtml(fund.ticker)}" />
              <button data-blacklist="${escapeHtml(fund.ticker)}" class="w-4 h-4 rounded text-slate-300 dark:text-slate-600 hover:text-rose-500 dark:hover:text-rose-400 leading-none transition" title="Blacklist ${escapeHtml(fund.ticker)} — hide it from All ETFs">✕</button>
            </span>
          </td>
          <td class="catalog-sticky-col catalog-sticky-ticker py-2.5 px-4 font-mono font-semibold text-blue-600 dark:text-blue-400">
            <button data-open-fund="${escapeHtml(fund.ticker)}" class="hover:underline focus:outline-none focus:underline" title="Open ${escapeHtml(fund.ticker)} details">${escapeHtml(fund.ticker)}</button>
          </td>
          <td class="py-2.5 px-4 text-slate-700 dark:text-slate-300 font-medium" title="${escapeHtml(fund.name)}">${escapeHtml(fund.name)}</td>
          <td class="py-2.5 px-4 text-slate-600 dark:text-slate-300">${escapeHtml(categoryLabel(fund.category))}</td>
          <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${escapeHtml(fund.nav || '—')}</td>
          <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${formatMoney(fund.aumValue)}</td>
          <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${escapeHtml(fund.ter || '—')}</td>
          <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${formatPercent(fund.dividendYield)}</td>
          <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${formatPercent(fund.secYield)}</td>
          <td class="py-2.5 px-4 text-slate-700 dark:text-slate-300">${escapeHtml(fund.dividendFrequency || '—')}</td>
          <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${formatPercent(fund.ytd)}</td>
          <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${formatPercent(fund.yr1)}</td>
          <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${formatPercent(fund.tr3y)}</td>
          <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${formatPercent(fund.tr5y)}</td>
          <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${formatPercent(fund.tr10y)}</td>
          <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${formatPercent(fund.cagr3y)}</td>
          <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${formatPercent(fund.cagr5y)}</td>
          <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${formatPercent(fund.cagr10y)}</td>
          <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${formatPercent(fund.si)}</td>
          <td class="py-2.5 px-4 font-mono text-slate-600 dark:text-slate-400">${escapeHtml(fund.returnAsOf || '—')}</td>
          <td class="py-2.5 px-4 font-mono text-slate-600 dark:text-slate-400">${escapeHtml(fund.inceptionDate || '—')}</td>
          <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${formatInteger(fund.holdings)}</td>
          <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${formatInteger(fund.history)}</td>
          <td class="py-2.5 px-4 font-mono text-slate-600 dark:text-slate-400">${escapeHtml(fund.asOfDate || '—')}</td>
        </tr>
      `;
    }).join('');
  }

  el.tableBody.querySelectorAll('input[data-checkbox]').forEach((checkbox: any) => {
    checkbox.addEventListener('change', (event: any) => {
      event.stopPropagation();
      const ticker = checkbox.dataset.checkbox || '';
      toggleFund(ticker);
    });
    checkbox.addEventListener('click', (event: any) => event.stopPropagation());
  });

  el.tableBody.querySelectorAll('button[data-open-fund]').forEach((button: any) => {
    button.addEventListener('click', (event: any) => {
      event.stopPropagation();
      openFundDetails(button.dataset.openFund || '');
    });
  });

  el.tableBody.querySelectorAll('button[data-blacklist]').forEach((button: any) => {
    button.addEventListener('click', (event: any) => {
      event.stopPropagation();
      blacklistTickers([button.dataset.blacklist || '']);
    });
  });

  const selected = state.selected.size;
  const queryText = currentQuery() ? ` matching “${currentQuery()}”` : '';
  const activeText = state.activeFundTicker ? ` Active ETF detail tabs are for ${state.activeFundTicker}.` : '';
  setStatus(`Showing ${rows.length} ETF${rows.length === 1 ? '' : 's'}${queryText}. Use the checkboxes in the “Use” column to select ETFs.${selected ? ` ${selected} selected.` : ' No ETFs selected yet.'}${activeText}`, selected ? 'success' : 'info');
  el.tickerCount.textContent = `${rows.length} ETFs`;
  renderSubtitle();
}

// - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

type HoldingPosition = {
  fund: string;
  symbol: string;
  key: string;
  name: string;
  weight: number;
  identifier: string;
  sector: string;
  marketValue: number;
};

function normalizeHoldingHeader(value: string): string {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

const MISSING_HOLDING_VALUES = new Set(['', '-', '--', '—', '–', 'n/a', 'na', 'none', 'null']);

function usableHoldingValue(value: unknown): string {
  const clean = String(value ?? '').trim();
  return !clean || MISSING_HOLDING_VALUES.has(clean.toLowerCase()) ? '' : clean;
}

/**
 * Converts the generated SPDR headers and common old/new provider payload
 * aliases into the one Watchlist position contract. In particular, a blank
 * or "-" Ticker must fall back to CUSIP / ISIN / Identifier / SEDOL so bond
 * positions are not silently dropped. A published security name is the last
 * resort for valid cash/derivative rows that genuinely have no identifier.
 */
function sheetPositions(ticker: string): HoldingPosition[] {
  const entry = sheetState.get(`${ticker}:holdings`);
  if (!entry || !entry.headers.length) return [];
  const headerIndexes: Map<string, number> = new Map();
  entry.headers.forEach((header, index) => headerIndexes.set(normalizeHoldingHeader(header), index));
  const value = (row: string[], aliases: string[]): string => {
    for (let i = 0; i < aliases.length; i++) {
      const index = headerIndexes.get(normalizeHoldingHeader(aliases[i]));
      if (index === undefined) continue;
      const found = usableHoldingValue(row[index]);
      if (found) return found;
    }
    return '';
  };

  const positions: HoldingPosition[] = [];
  entry.rows.forEach(row => {
    const publishedTicker = value(row, ['Ticker', 'Symbol', 'Security Ticker']);
    const cusip = value(row, ['CUSIP']);
    const isin = value(row, ['ISIN']);
    const identifier = value(row, ['Identifier', 'Security ID', 'securityId']);
    const sedol = value(row, ['SEDOL', 'FIGI']);
    const name = value(row, ['Name', 'Holding Name', 'holdingName', 'Security Long Description', 'securityLongDescription', 'Security Description']);
    let key = '';
    let shown = '';
    if (publishedTicker) { key = `T:${publishedTicker.toUpperCase()}`; shown = publishedTicker; }
    else if (cusip) { key = `C:${cusip.toUpperCase()}`; shown = cusip; }
    else if (isin) { key = `I:${isin.toUpperCase()}`; shown = isin; }
    else if (identifier) { key = `D:${identifier.toUpperCase()}`; shown = identifier; }
    else if (sedol) { key = `S:${sedol.toUpperCase()}`; shown = sedol; }
    else if (name) { key = `N:${name.toUpperCase()}`; shown = name; }
    else return;
    const weight = numberOrNull(value(row, ['Weight', 'Weight (%)', 'Market Value Percentage', 'marketValuePercentage']));
    const marketValue = numberOrNull(value(row, ['Market Value', 'Market Value Base Currency', 'marketValueBaseCurrency']));
    positions.push({
      fund: ticker,
      symbol: shown,
      key,
      name,
      weight: weight === null ? 0 : weight,
      identifier: identifier || cusip || isin || sedol,
      sector: value(row, ['Sector', 'GICS Sector', 'gicsSector']),
      marketValue: marketValue === null ? 0 : marketValue,
    });
  });
  return positions.filter(position => usableHoldingValue(position.symbol) !== '');
}

function getSelectedPositions(): HoldingPosition[] {
  return [...state.selected].flatMap(ticker => sheetPositions(ticker));
}

function invalidateWatchlistRows(): void {
  watchlistRevision += 1;
}

function getDedupedWatchlistRows(): WatchlistRow[] {
  if (cachedWatchlistRevision === watchlistRevision) return cachedWatchlistRows;
  const map: Map<string, WatchlistRow> = new Map();
  getSelectedPositions().forEach(position => {
    const symbol = position.symbol;
    const dedupeKey = position.key || `T:${String(symbol).toUpperCase()}`;
    if (!map.has(dedupeKey)) {
      map.set(dedupeKey, {
        symbol,
        name: position.name,
        funds: [],
        fundCount: 0,
        weightSum: 0,
        maxWeight: 0,
        marketValue: 0,
        sectors: [],
        sector: '',
        cusips: [],
        identifier: '',
        searchIndex: '',
        _key: dedupeKey,
      });
    }
    const row = map.get(dedupeKey);
    if (!row) return;
    if (!row.funds.includes(position.fund)) row.funds.push(position.fund);
    row.weightSum += position.weight;
    row.maxWeight = Math.max(row.maxWeight, position.weight);
    row.marketValue += position.marketValue;
    if (position.identifier && !row.cusips.includes(position.identifier)) row.cusips.push(position.identifier);
    if (position.sector && !row.sectors.includes(position.sector)) row.sectors.push(position.sector);
    if (position.name) row.name = position.name;
  });
  map.forEach(row => {
    row.fundCount = row.funds.length;
    row.funds.sort();
    row.cusips.sort();
    row.sectors.sort();
    row.identifier = row.cusips[0] || '';
    row.sector = row.sectors.join(', ');
    row.searchIndex = [row.symbol, row.name, row.cusips.join(' '), row.sectors.join(' '), row.funds.join(' ')].join(' ').toLowerCase();
  });
  cachedWatchlistRows = [...map.values()];
  cachedWatchlistRevision = watchlistRevision;
  return cachedWatchlistRows;
}

function getVisibleWatchlistRows(): WatchlistRow[] {
  const base = getDedupedWatchlistRows();
  return sortRows(applyColumnFilters('watchlist', filterRows(base), WATCHLIST_FILTER_COLUMNS, base));
}

function renderWatchlistTable(): void {
  const allRows = getVisibleWatchlistRows();
  const rows = allRows.slice(0, watchlistVisibleLimit);
  const progress = selectedHoldingsLoadState();
  renderedWatchlistTotal = allRows.length;
  el.tableHead.innerHTML = `
    <tr>
      ${indexHeader()}
      ${sortHeader('Ticker', 'symbol', false, ' watchlist-sticky-ticker')}
      ${sortHeader('Name', 'name')}
      ${sortHeader('ETFs', 'funds')}
      ${sortHeader('# ETFs', 'fundCount', true)}
      ${sortHeader('Weight Sum', 'weightSum', true)}
      ${sortHeader('Max Weight', 'maxWeight', true)}
      ${sortHeader('Market Value', 'marketValue', true)}
      ${sortHeader('Sector', 'sector')}
      ${sortHeader('Identifier', 'identifier')}
    </tr>
  `;
  bindSortHeaders();

  let emptyMessage = '';
  if (!state.selected.size) {
    emptyMessage = 'No ETFs selected yet. Select ETFs in All ETFs to build the aggregated Watchlist.';
  } else if (!allRows.length && currentQuery() && getDedupedWatchlistRows().length > 0) {
    emptyMessage = 'No Watchlist holdings match your search.';
  } else if (!allRows.length && progress.loading) {
    emptyMessage = `Loading holdings… ${progress.completeFunds} of ${progress.sourceFunds} selected ETF files ready.`;
  } else if (!allRows.length && progress.sourceFunds === 0) {
    emptyMessage = 'Holdings data is not available yet for the selected ETFs. Run the data refresh workflow to publish holdings pages.';
  } else if (!allRows.length) {
    emptyMessage = progress.failedFunds > 0
      ? 'Holdings data could not be loaded for one or more selected ETFs. Refresh the page or run the data refresh workflow.'
      : 'Holdings data is not available yet for the selected ETFs. Run the data refresh workflow to publish holdings pages.';
  }

  if (emptyMessage) {
    el.tableBody.innerHTML = `<tr><td colspan="10" class="py-12 text-center text-slate-400 dark:text-slate-500">${escapeHtml(emptyMessage)}</td></tr>`;
  } else {
    el.tableBody.innerHTML = rows.map((row, index) => `
      <tr class="hover:bg-slate-50 dark:hover:bg-slate-700/30 transition border-b border-slate-100 dark:border-slate-700/30">
        <td class="py-2.5 px-4 text-slate-400 dark:text-slate-500 text-xs text-center font-mono">${index + 1}</td>
        <td class="watchlist-sticky-ticker py-2.5 px-4 font-mono font-semibold text-blue-600 dark:text-blue-400" title="${escapeHtml(row.symbol)}">${escapeHtml(row.symbol)}</td>
        <td class="py-2.5 px-4 text-slate-700 dark:text-slate-300 font-medium" title="${escapeHtml(row.name)}">${escapeHtml(row.name || '—')}</td>
        <td class="py-2.5 px-4 text-slate-700 dark:text-slate-300">
          <div class="flex flex-wrap gap-1 max-w-md">
            ${row.funds.map((ticker: string) => `<button data-watchlist-fund="${escapeHtml(ticker)}" class="font-mono text-xs bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border border-blue-100 dark:border-blue-800 rounded-full px-2 py-0.5 hover:underline" title="Open ${escapeHtml(ticker)} details">${escapeHtml(ticker)}</button>`).join('')}
          </div>
        </td>
        <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${row.fundCount}</td>
        <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${row.weightSum.toFixed(3)}%</td>
        <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${row.maxWeight.toFixed(3)}%</td>
        <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${row.marketValue ? formatMoney(row.marketValue) : '—'}</td>
        <td class="py-2.5 px-4 text-slate-600 dark:text-slate-400">${escapeHtml(row.sector || '—')}</td>
        <td class="py-2.5 px-4 font-mono text-slate-600 dark:text-slate-400 text-xs">${escapeHtml(row.identifier || '—')}</td>
      </tr>
    `).join('');
  }

  el.tableBody.querySelectorAll('button[data-watchlist-fund]').forEach((button: any) => {
    button.addEventListener('click', () => openFundDetails(button.dataset.watchlistFund || ''));
  });

  const queryText = currentQuery() ? ` matching “${currentQuery()}”` : '';
  const loadingText = progress.loading ? ` Holdings are still loading (${progress.completeFunds}/${progress.sourceFunds} ETF files).` : '';
  setStatus(`Watchlist built from ${state.selected.size} selected ETF${state.selected.size === 1 ? '' : 's'}: ${allRows.length} deduplicated holding${allRows.length === 1 ? '' : 's'}${queryText}.${loadingText}`, progress.loading ? 'info' : 'success');
  el.tickerCount.textContent = `${allRows.length.toLocaleString('en-US')}${progress.loading ? '+' : ''} holdings`;
  renderSubtitle(`Watchlist from ${state.selected.size} selected ETF${state.selected.size === 1 ? '' : 's'} · showing ${rows.length.toLocaleString('en-US')} of ${allRows.length.toLocaleString('en-US')} deduplicated holdings${progress.loading ? ' while remaining files load' : ''}.`);
}

// - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

function renderDetailTable(key: string): void {
  const activeFund = getActiveFund();
  if (!activeFund) {
    renderEmptyDetail('Select an ETF row to see ETF details.');
    return;
  }

  if (key === 'overview') return renderOverviewTable(activeFund);
  if (key === 'distributions') return renderDistributionsTable(activeFund);
  return renderSheetTable(activeFund, key === 'history' ? 'history' : 'holdings');
}

function renderEmptyDetail(message: string): void {
  el.tableHead.innerHTML = `<tr>${indexHeader()}<th class="py-3.5 px-4">Details</th></tr>`;
  el.tableBody.innerHTML = `<tr><td colspan="2" class="py-12 text-center text-slate-400 dark:text-slate-500">${escapeHtml(message)}</td></tr>`;
  el.tickerCount.textContent = activeDetailTickerText();
}

function activeDetailTickerText(): string {
  return state.activeFundTicker ? `${state.activeFundTicker}` : '0 ETFs';
}

function renderMissingSheet(fund: FundRow, sheet: 'holdings' | 'history', message: string, error = false): void {
  const label = sheet === 'holdings' ? 'Holdings' : 'NAV History';
  el.tableHead.innerHTML = `<tr>${indexHeader()}<th class="py-3.5 px-4">${escapeHtml(fund.ticker)} ${label}</th></tr>`;
  el.tableBody.innerHTML = `<tr><td colspan="2" class="py-12 text-center ${error ? 'text-rose-500 dark:text-rose-300' : 'text-slate-400 dark:text-slate-500'}">${escapeHtml(message)}</td></tr>`;
  el.tickerCount.textContent = fund.ticker;
  renderSubtitle(message);
}

function renderSheetTable(fund: FundRow, sheet: 'holdings' | 'history'): void {
  const catalogCount = sheet === 'holdings' ? fund.holdings : fund.history;
  const key = `${fund.ticker}:${sheet}`;
  const entry = sheetState.get(key);
  const label = sheet === 'holdings' ? 'holdings workbook' : 'NAV history workbook';

  if (!catalogCount) {
    renderMissingSheet(fund, sheet, `${fund.ticker} publishes no ${label} (catalog-only fund, for example a commodity trust).`);
    return;
  }

  if (!entry) {
    const knownMeta = fundMetaCache.has(fund.ticker);
    const meta = knownMeta ? fundMetaCache.get(fund.ticker) : null;
    const manifest = meta && (sheet === 'holdings' ? meta.holdings : meta.history);
    if (fundMetaFailures.has(fund.ticker)) {
      renderMissingSheet(fund, sheet, `Could not load ${fund.ticker} data.`, true);
      return;
    }
    if (knownMeta && (!manifest || !Array.isArray(manifest.pages) || !manifest.pages.length)) {
      renderMissingSheet(fund, sheet, `${fund.ticker} has no published ${label} pages. Run the data refresh workflow if the catalog count is stale.`);
      return;
    }

    el.tableHead.innerHTML = `<tr>${indexHeader()}<th class="py-3.5 px-4">Loading…</th></tr>`;
    el.tableBody.innerHTML = `<tr><td colspan="2" class="py-12 text-center text-slate-400 dark:text-slate-500">Loading ${escapeHtml(fund.ticker)} ${sheet}…</td></tr>`;
    el.tickerCount.textContent = fund.ticker;
    renderSubtitle(`Loading ${fund.ticker} ${sheet}…`);
    void loadFundMeta(fund.ticker).then(loadedMeta => {
      if (state.activeFundTicker !== fund.ticker || state.activeTab !== `detail:${sheet}`) return;
      const loadedManifest = loadedMeta && (sheet === 'holdings' ? loadedMeta.holdings : loadedMeta.history);
      if (fundMetaFailures.has(fund.ticker) || !loadedManifest || !Array.isArray(loadedManifest.pages) || !loadedManifest.pages.length) {
        renderMissingSheet(fund, sheet, `Could not load ${fund.ticker} data.`, true);
        return;
      }
      void ensureSheet(sheet, loadedManifest).then(() => {
        if (state.activeFundTicker === fund.ticker && state.activeTab === `detail:${sheet}`) render();
      });
    });
    return;
  }

  const failure = sheetLoadFailures.get(key);
  if (!entry.headers.length) {
    if (failure) {
      renderMissingSheet(fund, sheet, `Could not load ${fund.ticker} data.`, true);
      return;
    }
    el.tableHead.innerHTML = `<tr>${indexHeader()}<th class="py-3.5 px-4">Loading…</th></tr>`;
    el.tableBody.innerHTML = `<tr><td colspan="2" class="py-12 text-center text-slate-400 dark:text-slate-500">Loading ${escapeHtml(fund.ticker)} ${sheet}…</td></tr>`;
    el.tickerCount.textContent = fund.ticker;
    renderSubtitle(`Loading ${fund.ticker} ${sheet}…`);
    if (!entry.loading && entry.nextPage < entry.manifest.pages.length) void loadNextSheetPage(sheet);
    return;
  }

  const headers = entry.headers;
  const rows = sortRows(sheetView(sheet, headers, entry.rows, NUMERIC_SHEET_HEADERS));

  el.tableHead.innerHTML = `
    <tr>
      ${indexHeader()}
      ${headers.map((header, index) => sortHeader(header || `Col ${index + 1}`, `col${index}`, NUMERIC_SHEET_HEADERS.includes(header))).join('')}
    </tr>
  `;
  bindSortHeaders();

  if (!rows.length) {
    el.tableBody.innerHTML = `<tr><td colspan="${headers.length + 1}" class="py-12 text-center text-slate-400 dark:text-slate-500">No rows match your search${entry.loading ? ' (still loading…)' : ''}.</td></tr>`;
  } else {
    el.tableBody.innerHTML = rows.map((row, index) => {
      const values: string[] = row.values || [];
      return `
      <tr class="hover:bg-slate-50 dark:hover:bg-slate-700/30 transition border-b border-slate-100 dark:border-slate-700/30">
        <td class="py-2.5 px-4 text-slate-400 dark:text-slate-500 text-xs text-center font-mono">${index + 1}</td>
        ${values.map((cell, columnIndex) => `
          <td class="py-2.5 px-4 ${NUMERIC_SHEET_HEADERS.includes(headers[columnIndex]) ? 'text-right font-mono text-slate-700 dark:text-slate-300' : 'text-slate-700 dark:text-slate-300'}">${escapeHtml(cell === '' ? '—' : cell)}</td>
        `).join('')}
      </tr>
    `;}).join('');
  }

  el.tickerCount.textContent = fund.ticker;
  renderSubtitle(`${fund.ticker} ${sheet === 'holdings' ? 'Holdings' : 'NAV History'} — ${entry.rows.length.toLocaleString('en-US')} of ${(entry.manifest.totalRows || 0).toLocaleString('en-US')} rows loaded${entry.manifest.asOfDate ? ` (as of ${entry.manifest.asOfDate})` : ''}.`);
}

function renderOverviewTable(fund: FundRow): void {
  if (!fundMetaCache.has(fund.ticker) && !fundMetaRequests.has(fund.ticker)) void loadFundMeta(fund.ticker);
  const meta = fundMetaCache.get(fund.ticker);
  const monthEnd = (fund.returns && fund.returns.monthEnd) || {};
  const quarterEnd = (fund.returns && fund.returns.quarterEnd) || {};
  const overview: Array<{ section: string; metric: string; value: unknown }> = [
    { section: 'Fund', metric: 'Ticker', value: fund.ticker },
    { section: 'Fund', metric: 'Fund Name', value: fund.name },
    { section: 'Fund', metric: 'Asset Class', value: categoryLabel(fund.category) },
    { section: 'Fund', metric: 'Inception', value: fund.inceptionDate },
    { section: 'Fund', metric: 'Exchange', value: fund.exchange },
    { section: 'Fund', metric: 'Fund Page', value: fund.fundPage },
    { section: 'Fund', metric: 'Factsheet', value: meta && meta.source ? meta.source.factsheet : null },
    { section: 'Fund', metric: 'ISIN', value: fund.isin ?? (meta && meta.identifiers ? meta.identifiers.isin : null) },
    { section: 'Fund', metric: 'CUSIP', value: fund.cusip ?? (meta && meta.identifiers ? meta.identifiers.cusip : null) },
    { section: 'Cost', metric: 'TER (Gross Expense Ratio)', value: fund.ter },
    { section: 'Cost', metric: 'Net Expense Ratio', value: meta && meta.netExpenseRatio ? meta.netExpenseRatio.display : null },
    { section: 'Price', metric: 'NAV', value: fund.nav },
    { section: 'Price', metric: 'Close Price', value: fund.closePrice },
    { section: 'Price', metric: 'Premium / Discount', value: fund.premiumDiscount },
    { section: 'Price', metric: 'As Of', value: fund.asOfDate },
    { section: 'Assets', metric: 'Net Assets', value: formatMoney(fund.aumValue) },
    { section: 'Assets', metric: 'Net Assets (published)', value: fund.aum },
    { section: 'Returns', metric: 'Month-End As Of', value: monthEnd.asOfDate },
    { section: 'Returns', metric: 'YTD (ME)', value: formatPercent(monthEnd.ytd) },
    { section: 'Returns', metric: '1Y (ME)', value: formatPercent(monthEnd.yr1) },
    { section: 'Returns', metric: '3Y CAGR (ME)', value: formatPercent(monthEnd.yr3) },
    { section: 'Returns', metric: '5Y CAGR (ME)', value: formatPercent(monthEnd.yr5) },
    { section: 'Returns', metric: '10Y CAGR (ME)', value: formatPercent(monthEnd.yr10) },
    { section: 'Returns', metric: 'SI Ann. (ME)', value: formatPercent(monthEnd.sinceInception) },
    { section: 'Returns', metric: 'Quarter-End As Of', value: quarterEnd.asOfDate },
    { section: 'Returns', metric: 'YTD (QE)', value: formatPercent(quarterEnd.ytd) },
    { section: 'Returns', metric: '1Y (QE)', value: formatPercent(quarterEnd.yr1) },
    { section: 'Returns', metric: '3Y CAGR (QE)', value: formatPercent(quarterEnd.yr3) },
    { section: 'Returns', metric: '5Y CAGR (QE)', value: formatPercent(quarterEnd.yr5) },
    { section: 'Returns', metric: '10Y CAGR (QE)', value: formatPercent(quarterEnd.yr10) },
    { section: 'Returns', metric: 'SI Ann. (QE)', value: formatPercent(quarterEnd.sinceInception) },
    { section: 'Distributions', metric: 'Frequency', value: fund.distributions ? fund.distributions.frequency : null },
    { section: 'Distributions', metric: 'Ex-Date', value: fund.distributions ? fund.distributions.exDate : null },
    { section: 'Distributions', metric: 'Latest Dividend', value: fund.distributions ? fund.distributions.dividend : null },
    { section: 'Distributions', metric: 'Dividend Yield', value: fund.dividendYield === null || fund.dividendYield === undefined ? null : `${fund.dividendYield.toFixed(2)}%${meta && meta.metrics && meta.metrics.dividendYieldSource === 'indicated' ? ' (indicated: latest distribution x frequency / NAV)' : ' (official, SSGA Fund Dividend Yield)'}` },
    { section: 'Distributions', metric: 'SEC Yield (30-day)', value: fund.secYield === null || fund.secYield === undefined ? null : `${fund.secYield.toFixed(2)}%` },
    { section: 'Holdings', metric: 'Holdings Rows', value: fund.holdings },
    { section: 'Holdings', metric: 'Holdings As Of', value: meta && meta.holdings ? meta.holdings.asOfDate : null },
    { section: 'Holdings', metric: 'History Rows', value: fund.history },
  ];
  const rows = sortRows(filterRows(overview.map(item => ({
    section: item.section,
    metric: item.metric,
    value: item.value === null || item.value === undefined || item.value === '' ? '—' : item.value,
    searchIndex: `${item.section} ${item.metric} ${item.value}`.toLowerCase(),
  }))));

  el.tableHead.innerHTML = `
    <tr>
      ${indexHeader()}
      ${sortHeader('Section', 'section')}
      ${sortHeader('Metric', 'metric')}
      ${sortHeader('Value', 'value')}
    </tr>
  `;
  bindSortHeaders();

  if (!rows.length) {
    el.tableBody.innerHTML = `<tr><td colspan="4" class="py-12 text-center text-slate-400 dark:text-slate-500">No overview metrics match your search.</td></tr>`;
  } else {
    el.tableBody.innerHTML = rows.map((row, index) => `
      <tr class="hover:bg-slate-50 dark:hover:bg-slate-700/30 transition border-b border-slate-100 dark:border-slate-700/30">
        <td class="py-2.5 px-4 text-slate-400 dark:text-slate-500 text-xs text-center font-mono">${index + 1}</td>
        <td class="py-2.5 px-4 text-slate-500 dark:text-slate-400">${escapeHtml(row.section)}</td>
        <td class="py-2.5 px-4 text-slate-700 dark:text-slate-300 font-medium">${escapeHtml(row.metric)}</td>
        <td class="py-2.5 px-4 text-slate-700 dark:text-slate-300 font-mono">${
          /^https?:\/\//.test(String(row.value))
            ? `<a class="text-blue-600 dark:text-blue-400 hover:underline" href="${escapeHtml(row.value)}" target="_blank" rel="noopener noreferrer">open link</a>`
            : escapeHtml(row.value)
        }</td>
      </tr>
    `).join('');
  }

  el.tickerCount.textContent = fund.ticker;
  renderSubtitle(`${fund.ticker} overview · ${rows.length} metrics. ME = SSGA month-end NAV series, QE = quarter-end NAV series.`);
}

function rowsForStaticHeaders(headers: string[], rawRows: any[]): string[][] {
  return rawRows.map(rawRow => {
    if (Array.isArray(rawRow)) return headers.map((_, index) => String(rawRow[index] ?? ''));
    const keyByNormalized: Map<string, string> = new Map();
    Object.keys(rawRow || {}).forEach(key => keyByNormalized.set(normalizeHoldingHeader(key), key));
    return headers.map(header => {
      if (rawRow && rawRow[header] !== undefined) return String(rawRow[header] ?? '');
      const fallbackKey = keyByNormalized.get(normalizeHoldingHeader(header));
      return fallbackKey && rawRow ? String(rawRow[fallbackKey] ?? '') : '';
    });
  });
}

function renderDistributionsTable(fund: FundRow): void {
  if (!fundMetaCache.has(fund.ticker)) {
    el.tableHead.innerHTML = `<tr>${indexHeader()}<th class="py-3.5 px-4">Loading…</th></tr>`;
    el.tableBody.innerHTML = `<tr><td colspan="2" class="py-12 text-center text-slate-400 dark:text-slate-500">Loading ${escapeHtml(fund.ticker)} distributions…</td></tr>`;
    el.tickerCount.textContent = fund.ticker;
    renderSubtitle(`Loading ${fund.ticker} distributions…`);
    void loadFundMeta(fund.ticker).then(meta => {
      if (state.activeFundTicker !== fund.ticker || state.activeTab !== 'detail:distributions') return;
      if (!meta) {
        el.tableBody.innerHTML = `<tr><td colspan="2" class="py-12 text-center text-slate-400 dark:text-slate-500">No published distributions are available for ${escapeHtml(fund.ticker)}.</td></tr>`;
        return;
      }
      render();
    });
    return;
  }

  const meta = fundMetaCache.get(fund.ticker);
  const worksheet = meta && meta.distributions ? meta.distributions : { headers: [], rows: [] };
  const headers: string[] = Array.isArray(worksheet.headers) ? worksheet.headers : [];
  const sourceRows = rowsForStaticHeaders(headers, Array.isArray(worksheet.rows) ? worksheet.rows : []);
  const rows = sortRows(sheetView('distributions', headers, sourceRows, []));

  el.tableHead.innerHTML = `
    <tr>
      ${indexHeader()}
      ${headers.length ? headers.map((header, index) => sortHeader(header, `col${index}`)).join('') : '<th class="py-3.5 px-4">Distributions</th>'}
    </tr>
  `;
  bindSortHeaders();

  if (!rows.length) {
    el.tableBody.innerHTML = `<tr><td colspan="${Math.max(2, headers.length + 1)}" class="py-12 text-center text-slate-400 dark:text-slate-500">No published distribution for ${escapeHtml(fund.ticker)}.</td></tr>`;
  } else {
    el.tableBody.innerHTML = rows.map((row, index) => {
      const values: string[] = row.values || [];
      return `
      <tr class="hover:bg-slate-50 dark:hover:bg-slate-700/30 transition border-b border-slate-100 dark:border-slate-700/30">
        <td class="py-2.5 px-4 text-slate-400 dark:text-slate-500 text-xs text-center font-mono">${index + 1}</td>
        ${values.map(cell => `<td class="py-2.5 px-4 text-slate-700 dark:text-slate-300 font-mono">${escapeHtml(cell || '—')}</td>`).join('')}
      </tr>
    `;}).join('');
  }

  el.tickerCount.textContent = fund.ticker;
  renderSubtitle(`${fund.ticker} distributions · latest row from the SSGA dividend feed (frequency, ex-date, payable date, dividend, capital gains).`);
}

// =========================================================================
// 7. Subtitle
// =========================================================================

function renderHeaderSummary(subtitle: HTMLElement, tickers: Iterable<string>, activeTicker: string | null, activate: (ticker: string) => void): void {
  const panel = document.getElementById('app-summary');
  if (!panel) return;
  // Move existing nodes: provenance links and their handlers remain intact.
  panel.replaceChildren(...Array.from(subtitle.childNodes));
  subtitle.replaceChildren();
  const selected = [...tickers].sort();
  if (!selected.length) return;
  subtitle.append(document.createTextNode(`${selected.length} selected: `));
  selected.forEach((ticker, index) => {
    if (index) subtitle.append(document.createTextNode(', '));
    const link = document.createElement('a');
    link.href = '#';
    link.dataset.headerFund = ticker;
    link.title = `View ${ticker} details`;
    link.className = `font-semibold ${ticker === activeTicker ? 'text-blue-700 dark:text-blue-300 underline' : 'text-blue-600 dark:text-blue-400 hover:underline'}`;
    link.textContent = ticker;
    link.addEventListener('click', event => { event.preventDefault(); activate(ticker); });
    subtitle.append(link);
  });
}

function renderSubtitleDetails(text?: string): void {
  const generated = state.generatedAt ? new Date(state.generatedAt).toLocaleString() : '';
  const countsText = state.counts
    ? `${state.counts.funds} ETFs · ${(state.counts.holdings || 0).toLocaleString('en-US')} holdings rows · ${(state.counts.history || 0).toLocaleString('en-US')} history rows`
    : '';
  const base = text ? String(text) : 'Search SPDR ETFs, select ETFs via the “Use” checkbox, then use the Watchlist tab.';
  const selectedTickers = [...state.selected].sort();
  const selectedSummary = selectedTickers.length ? `
    <span id="selected-etf-summary" class="flex items-center gap-1.5 min-w-0 mt-1" aria-live="polite">
      <strong class="shrink-0 text-slate-600 dark:text-slate-300">${selectedTickers.length.toLocaleString('en-US')} selected:</strong>
      <span class="inline-flex items-center gap-1 min-w-0 max-w-full overflow-x-auto pb-0.5 themed-scroll">
        ${selectedTickers.map(ticker => `<button data-selected-fund="${escapeHtml(ticker)}" class="shrink-0 rounded-full border px-2 py-0.5 font-mono text-xs ${ticker === state.activeFundTicker ? 'bg-blue-600 border-blue-500 text-white' : 'bg-blue-50 dark:bg-blue-900/30 border-blue-100 dark:border-blue-800 text-blue-700 dark:text-blue-300'} hover:underline" title="Open ${escapeHtml(ticker)} details">${escapeHtml(ticker)}</button>`).join('')}
      </span>
    </span>
  ` : '';
  el.subtitle.innerHTML = `
    <span class="block sm:inline">${escapeHtml(base)}</span>
    <span class="block sm:inline">·${generated ? ` updated ${escapeHtml(generated)}` : ''}${countsText ? ` · ${escapeHtml(countsText)}.` : '.'} Data: <a href="./api/spdr/index.json" target="_blank" rel="noopener noreferrer" class="font-semibold text-blue-600 dark:text-blue-400 hover:underline">api/spdr/index.json</a> generated from <a href="https://www.ssga.com/us/en/intermediary/etfs/fund-finder" target="_blank" rel="noopener noreferrer" class="font-semibold text-blue-600 dark:text-blue-400 hover:underline">SSGA SPDR ETFs</a></span>
    ${selectedSummary}
  `;
  el.subtitle.querySelectorAll('button[data-selected-fund]').forEach((button: any) => {
    button.addEventListener('click', () => openFundDetails(button.dataset.selectedFund || ''));
  });
}

function renderSubtitle(text?: string): void {
  renderSubtitleDetails(text);
  renderHeaderSummary(el.subtitle, state.selected, state.activeFundTicker, openFundDetails);
}

function setStatusRow(message: string, tone: 'info' | 'error'): void {
  el.tableBody.innerHTML = `<tr><td colspan="10" class="py-12 text-center ${tone === 'error' ? 'text-rose-500 dark:text-rose-300' : 'text-slate-400 dark:text-slate-500'}">${escapeHtml(message)}</td></tr>`;
}

// =========================================================================
// 8. Selection & blacklist
// =========================================================================

/** Coalesces progressive holdings/meta updates into a responsive UI refresh. */
function scheduleSelectionDataRefresh(ticker = ''): void {
  if (ticker) selectionDataChangedTickers.add(ticker);
  if (selectionDataRefreshTimer !== null) return;
  selectionDataRefreshTimer = setTimeout(() => {
    selectionDataRefreshTimer = null;
    const activeFundChanged = Boolean(state.activeFundTicker && selectionDataChangedTickers.has(state.activeFundTicker));
    selectionDataChangedTickers.clear();
    ensureValidTab();
    if (state.activeTab === 'watchlist' || (isDetailTab(state.activeTab) && activeFundChanged)) {
      render();
    } else {
      // Keep the current table/scroll position stable while only selected-tab
      // counts (especially Watchlist) change in the background.
      renderTabs();
      fitTableHeight();
    }
  }, 75);
}

function openFundDetails(ticker: string): void {
  const cleanTicker = sanitizeTicker(ticker);
  const known = state.funds.some(fund => fund.ticker === cleanTicker);
  if (!cleanTicker || !known || state.blacklist.has(cleanTicker)) return;
  if (!state.selected.has(cleanTicker)) {
    state.selected.add(cleanTicker);
    invalidateWatchlistRows();
  }
  state.activeFundTicker = cleanTicker;
  persistSelection();
  switchTab('detail:overview');
  void ensureHoldingsForSelection();
  void loadFundMeta(cleanTicker);
}

function toggleFund(ticker: string): void {
  const cleanTicker = sanitizeTicker(ticker);
  if (!cleanTicker) return;
  const previousActiveFund = state.activeFundTicker;

  if (state.selected.has(cleanTicker)) {
    state.selected.delete(cleanTicker);
    if (state.activeFundTicker === cleanTicker) state.activeFundTicker = [...state.selected][0] || null;
  } else {
    state.selected.add(cleanTicker);
    state.activeFundTicker = cleanTicker;
  }

  invalidateWatchlistRows();
  watchlistVisibleLimit = WATCHLIST_PAGE_SIZE;
  if (previousActiveFund !== state.activeFundTicker) resetSheetPaging();
  persistSelection();
  ensureValidTab();
  render();
  void ensureHoldingsForSelection();
  const activeTicker = state.activeFundTicker;
  if (activeTicker && state.activeTab.startsWith('detail:')) void loadFundMeta(activeTicker);
}

/**
 * Toggles the selection in bulk. `scope`:
 *  - 'visible' (header "Use" checkbox) — only the rows currently rendered in
 *    the catalog table: current tab + active search filter (visibleFunds is
 *    already tab-scoped and blacklist-excluded). Selecting with a filter
 *    active must not drag the hidden ETFs into the selection, and unchecking
 *    must not drop selections the user made while a different filter was on.
 *  - 'catalog' (checkbox in the All ETFs pill) — every non-blacklisted ETF,
 *    regardless of the current tab or filter; it sits next to the
 *    "All ETFs (N)" count and represents the whole catalog.
 */
function toggleSelectAll(selectAll: boolean, scope: 'visible' | 'catalog'): void {
  const previousActiveFund = state.activeFundTicker;
  const candidates = scope === 'visible'
    ? visibleCatalogRows()
    : state.funds.filter(fund => !state.blacklist.has(fund.ticker));
  candidates.forEach(fund => {
    if (selectAll) state.selected.add(fund.ticker);
    else state.selected.delete(fund.ticker);
  });
  if (!state.selected.size) state.activeFundTicker = null;
  else if (!state.activeFundTicker || !state.selected.has(state.activeFundTicker)) {
    state.activeFundTicker = [...state.selected][0] || null;
  }
  invalidateWatchlistRows();
  watchlistVisibleLimit = WATCHLIST_PAGE_SIZE;
  if (previousActiveFund !== state.activeFundTicker) resetSheetPaging();
  persistSelection();
  ensureValidTab();
  render();
  void ensureHoldingsForSelection();
}

function clearSelectionAndSearch(): void {
  state.selected.clear();
  state.activeFundTicker = null;
  state.queryByTab = {};
  state.activeTab = 'All';
  invalidateWatchlistRows();
  watchlistVisibleLimit = WATCHLIST_PAGE_SIZE;
  resetSheetPaging();
  // Sort preferences survive Clear: a sort configured in the past is always
  // kept (per tab, in browser localStorage) and reused. Clear only resets
  // the selection and the searches — never the sort order.
  applySortForTab('All');
  persistSelection();
  try { localStorage.removeItem(ACTIVE_FUND_KEY); } catch { /* ignore */ }
  el.searchInput.value = '';
  updateSearchClearBtn();
  persistTabFilters();
  persistSiteState();
  render();
}

function blacklistTickers(rawTickers: string[]): void {
  const previousActiveFund = state.activeFundTicker;
  const known = new Set(state.funds.map(fund => fund.ticker));
  rawTickers
    .flatMap(raw => String(raw || '').split(/[\s,;]+/))
    .map(sanitizeTicker)
    .filter(Boolean)
    .filter(ticker => known.has(ticker))
    .forEach(ticker => state.blacklist.add(ticker));
  state.selected = new Set([...state.selected].filter(ticker => !state.blacklist.has(ticker)));
  if (state.activeFundTicker && state.blacklist.has(state.activeFundTicker)) {
    state.activeFundTicker = [...state.selected][0] || null;
  }
  invalidateWatchlistRows();
  watchlistVisibleLimit = WATCHLIST_PAGE_SIZE;
  if (previousActiveFund !== state.activeFundTicker) resetSheetPaging();
  persistBlacklist();
  persistSelection();
  ensureValidTab();
  render();
  void ensureHoldingsForSelection();
}

function submitBlacklistInput(): void {
  blacklistTickers([el.blacklistInput.value || '']);
  el.blacklistInput.value = '';
  fitTableHeight();
}

function unblacklistTicker(ticker: string): void {
  state.blacklist.delete(sanitizeTicker(ticker));
  persistBlacklist();
  render();
}

function clearBlacklist(): void {
  state.blacklist.clear();
  persistBlacklist();
  render();
}

function renderBlacklistPanel(): void {
  el.blacklistChips.innerHTML = '';
  const tickers = [...state.blacklist].sort();
  tickers.forEach(ticker => {
    const chip = document.createElement('span');
    chip.className = 'inline-flex items-center gap-1.5 bg-rose-100 dark:bg-rose-900/40 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-700/50 rounded-full pl-3 pr-1.5 py-1 text-xs font-medium';
    chip.innerHTML = `${escapeHtml(ticker)}<button data-unblacklist="${escapeHtml(ticker)}" class="w-5 h-5 rounded-full hover:bg-rose-200 dark:hover:bg-rose-800 transition" title="Remove ${escapeHtml(ticker)} from blacklist">✕</button>`;
    el.blacklistChips.appendChild(chip);
  });
  el.blacklistEmpty.classList.toggle('hidden', tickers.length > 0);
  el.blacklistChips.querySelectorAll('button[data-unblacklist]').forEach((button: any) => {
    button.addEventListener('click', () => unblacklistTicker(button.dataset.unblacklist || ''));
  });
  syncBlacklistPanelHeight();
}

/**
 * The blacklist panel's max-height is content-driven (an unbounded number of
 * chips), unlike the fixed-height detail nav, so it can't use a static
 * max-height in CSS -- it's measured from scrollHeight instead, and
 * re-measured on every render so the panel resizes smoothly as chips are
 * added or removed while it's open.
 */
function syncBlacklistPanelHeight(): void {
  el.blacklistPanel.style.maxHeight = el.blacklistPanel.classList.contains('is-visible')
    ? `${el.blacklistPanel.scrollHeight}px`
    : '';
}

// =========================================================================
// 9. Actions & exports (CSV, TXT, Copy Tickers)
// =========================================================================

function currentExportRows(): { headers: string[]; rows: string[][]; scope: string } {
  if (state.activeTab === 'watchlist') {
    return {
      headers: ['Ticker', 'Name', 'ETFs', '# ETFs', 'Weight Sum (%)', 'Max Weight (%)', 'Market Value', 'Sector', 'Identifiers'],
      rows: getVisibleWatchlistRows().map(row => [
        row.symbol,
        row.name,
        row.funds.join('|'),
        String(row.fundCount),
        row.weightSum.toFixed(6),
        row.maxWeight.toFixed(6),
        numberCell(row.marketValue),
        row.sector,
        row.cusips.join('|'),
      ]),
      scope: 'watchlist',
    };
  }

  if (state.activeTab === 'detail:overview') {
    const fund = getActiveFund();
    const monthEnd = (fund && fund.returns && fund.returns.monthEnd) || {};
    const quarterEnd = (fund && fund.returns && fund.returns.quarterEnd) || {};
    return {
      headers: ['Ticker', 'Fund Name', 'Category', 'TER', 'NAV', 'Net Assets ($)', 'YTD (ME)', '1Y (ME)', '3Y (ME)', '5Y (ME)', '10Y (ME)', 'SI Ann. (ME)', 'ME As Of', '1Y (QE)', '3Y (QE)', 'Inception', 'Holdings', 'History'],
      rows: [[
        fund ? fund.ticker : '',
        fund ? fund.name : '',
        fund ? fund.category : '',
        fund ? fund.ter : '',
        fund ? fund.nav : '',
        fund ? numberCell(fund.aumValue) : '',
        numberCell(monthEnd.ytd),
        numberCell(monthEnd.yr1),
        numberCell(monthEnd.yr3),
        numberCell(monthEnd.yr5),
        numberCell(monthEnd.yr10),
        numberCell(monthEnd.sinceInception),
        monthEnd.asOfDate || '',
        numberCell(quarterEnd.yr1),
        numberCell(quarterEnd.yr3),
        fund ? fund.inceptionDate : '',
        fund ? String(fund.holdings) : '0',
        fund ? String(fund.history) : '0',
      ]],
      scope: fund ? `${fund.ticker}-overview` : 'overview',
    };
  }

  if (state.activeTab === 'detail:distributions') {
    const fund = getActiveFund();
    const meta = fund ? fundMetaCache.get(fund.ticker) : null;
    const worksheet = meta && meta.distributions ? meta.distributions : { headers: [], rows: [] };
    return {
      headers: worksheet.headers || [],
      rows: sheetView('distributions', worksheet.headers || [], worksheet.rows || [], []).map((row: any) => row.values),
      scope: fund ? `${fund.ticker}-distributions` : 'distributions',
    };
  }

  if (state.activeTab === 'detail:holdings' || state.activeTab === 'detail:history') {
    const sheet = state.activeTab === 'detail:history' ? 'history' : 'holdings';
    const fund = getActiveFund();
    const entry = fund ? sheetState.get(sheetKey(sheet)) : null;
    if (entry) {
      return {
        headers: entry.headers,
        rows: sheetView(sheet, entry.headers, entry.rows, NUMERIC_SHEET_HEADERS).map((row: any) => row.values),
        scope: fund ? `${fund.ticker}-${sheet}` : sheet,
      };
    }
    return { headers: [], rows: [], scope: sheet };
  }

  return {
    headers: ['Selected', 'Ticker', 'Fund Name', 'Type', 'NAV', 'Net Assets ($)', 'Expense (%)', 'Dividend Yield (%)', 'SEC Yield (%)', 'Frequency', 'YTD Return (%)', 'TR 1Y (%)', 'TR 3Y (%)', 'TR 5Y (%)', 'TR 10Y (%)', 'CAGR 3Y (%)', 'CAGR 5Y (%)', 'CAGR 10Y (%)', 'SI Ann. (%)', 'Return As Of', 'Inception', 'Holdings', 'History', 'As Of'],
    rows: filteredCatalogFunds().map(fund => [
      state.selected.has(fund.ticker) ? 'yes' : 'no',
      fund.ticker,
      fund.name,
      fund.category,
      fund.nav || '',
      numberCell(fund.aumValue),
      numberCell(fund.terValue),
      numberCell(fund.dividendYield),
      numberCell(fund.secYield),
      fund.dividendFrequency || '',
      numberCell(fund.ytd),
      numberCell(fund.yr1),
      numberCell(fund.tr3y),
      numberCell(fund.tr5y),
      numberCell(fund.tr10y),
      numberCell(fund.cagr3y),
      numberCell(fund.cagr5y),
      numberCell(fund.cagr10y),
      numberCell(fund.si),
      fund.returnAsOf || '',
      fund.inceptionDate || '',
      String(fund.holdings),
      String(fund.history),
      fund.asOfDate || '',
    ]),
    scope: 'etfs',
  };
}

function copyTickers(): void {
  let values: string[] = [];
  if (state.activeTab === 'watchlist') values = getVisibleWatchlistRows().map(row => row.symbol);
  else if (isDetailTab(state.activeTab)) values = currentExportRows().rows.map(row => String(row[0] ?? '')).filter(Boolean);
  else values = filteredCatalogFunds().map(fund => fund.ticker);
  values = values.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!values.length) return;
  void copyText(values.join(', ')).then(() => {
    const oldText = el.copyBtn.textContent;
    el.copyBtn.textContent = 'Copied!';
    setTimeout(() => { el.copyBtn.textContent = oldText || 'Copy Tickers'; }, 1000);
  });
}

function exportCsv(): void {
  const exportData = currentExportRows();
  if (!exportData.rows.length) return;
  downloadText(
    toCsv([exportData.headers, ...exportData.rows.map(row => row.map(cell => String(cell ?? '')))]),
    exportFileName(exportData.scope, 'csv'),
    'text/csv;charset=utf-8;',
  );
}

function exportTxt(): void {
  const exportData = currentExportRows();
  if (!exportData.rows.length) return;
  downloadText(exportData.rows.map(row => row.join('\t')).join('\n'), exportFileName(exportData.scope, 'txt'), 'text/plain;charset=utf-8;');
}

// =========================================================================
// 10. Scroll fix: only the table scrolls (same fix as daggerok/iShares)
// =========================================================================

function fitTableHeight(): void {
  const rect = el.tableScroll.getBoundingClientRect();
  const bottomPad = window.innerWidth < 640 ? 12 : 24;
  const max = Math.max(240, window.innerHeight - rect.top - bottomPad);
  el.tableScroll.style.maxHeight = `${max}px`;
}

// =========================================================================
// 11. State persistence
// =========================================================================

function persistSelection(): void {
  try {
    localStorage.setItem(SELECTED_KEY, JSON.stringify([...state.selected]));
    if (state.activeFundTicker) localStorage.setItem(ACTIVE_FUND_KEY, state.activeFundTicker);
    else localStorage.removeItem(ACTIVE_FUND_KEY);
  } catch {
    /* quota or private mode */
  }
  persistSiteState();
}

function persistBlacklist(): void {
  try {
    localStorage.setItem(BLACKLIST_KEY, JSON.stringify([...state.blacklist]));
  } catch {
    /* quota or private mode */
  }
}

function cleanTabFilters(source: Record<string, unknown> | null | undefined): Record<string, string> {
  const clean: Record<string, string> = {};
  if (!source || typeof source !== 'object' || Array.isArray(source)) return clean;
  Object.keys(source).forEach(tab => {
    const query = source[tab];
    if (typeof query === 'string' && query.length > 0) clean[tab] = query;
  });
  return clean;
}

function cleanTabSorts(source: Record<string, unknown> | null | undefined): Record<string, { key: string; dir: SortDirection }> {
  const clean: Record<string, { key: string; dir: SortDirection }> = {};
  if (!source || typeof source !== 'object' || Array.isArray(source)) return clean;
  Object.keys(source).forEach(tab => {
    const entry: any = source[tab];
    if (entry && typeof entry.key === 'string' && entry.key !== '' && (entry.dir === 'asc' || entry.dir === 'desc')) {
      clean[tab] = { key: entry.key, dir: entry.dir };
    }
  });
  return clean;
}

function persistTabFilters(): void {
  try {
    const clean = cleanTabFilters(state.queryByTab);
    if (Object.keys(clean).length > 0) localStorage.setItem(FILTERS_KEY, JSON.stringify(clean));
    else localStorage.removeItem(FILTERS_KEY);
    localStorage.removeItem(SEARCHES_KEY);
  } catch {
    /* quota or private mode */
  }
  persistSiteState();
}

function persistSearches(): void {
  persistTabFilters();
}

function persistTabSorts(): void {
  try {
    const clean = cleanTabSorts(state.sortByTab);
    if (Object.keys(clean).length > 0) localStorage.setItem(SORTS_KEY, JSON.stringify(clean));
    else localStorage.removeItem(SORTS_KEY);
  } catch {
    /* quota or private mode */
  }
  persistSiteState();
}

function persistSiteState(): void {
  try {
    localStorage.setItem(SITE_STATE_KEY, JSON.stringify({
      activeTab: state.activeTab,
      activeFundTicker: state.activeFundTicker,
      sheetFilter: cleanTabFilters(state.queryByTab),
      sheetSort: cleanTabSorts(state.sortByTab),
    }));
  } catch {
    /* quota or private mode */
  }
}

function restoreTabSorts(): void {
  let sorts: Record<string, { key: string; dir: SortDirection }> = {};
  try {
    const fromSite = JSON.parse(localStorage.getItem(SITE_STATE_KEY) || 'null');
    if (fromSite && typeof fromSite === 'object' && !Array.isArray(fromSite)) {
      Object.assign(sorts, cleanTabSorts(fromSite.sheetSort));
    }
  } catch {
    /* corrupt site-state */
  }
  try {
    const saved = JSON.parse(localStorage.getItem(SORTS_KEY) || 'null');
    Object.assign(sorts, cleanTabSorts(saved));
  } catch {
    /* corrupt sorts key */
  }
  state.sortByTab = sorts;
}

function restoreSelectedEtfs(): void {
  try {
    const saved = JSON.parse(localStorage.getItem(SELECTED_KEY) || '[]');
    state.selected = new Set((Array.isArray(saved) ? saved : []).map(sanitizeTicker).filter(Boolean));
    if (!state.selected.size && localStorage.getItem(SELECTED_KEY) === null) state.selected = new Set(DEFAULT_SELECTED_TICKERS);
  } catch {
    state.selected = new Set(DEFAULT_SELECTED_TICKERS);
  }
  const savedActive = sanitizeTicker(localStorage.getItem(ACTIVE_FUND_KEY) || '');
  state.activeFundTicker = savedActive && state.selected.has(savedActive) ? savedActive : ([...state.selected][0] || null);
}

function restoreBlacklist(): void {
  try {
    const saved = JSON.parse(localStorage.getItem(BLACKLIST_KEY) || 'null');
    if (Array.isArray(saved)) state.blacklist = new Set(saved.map(sanitizeTicker));
  } catch {
    // Ignore malformed storage.
  }
}

function restoreSearches(): void {
  restoreTabFilters();
}

function restoreTabFilters(): void {
  let filters: Record<string, string> = {};
  try {
    const fromSite = JSON.parse(localStorage.getItem(SITE_STATE_KEY) || 'null');
    if (fromSite && typeof fromSite === 'object' && !Array.isArray(fromSite)) {
      Object.assign(filters, cleanTabFilters(fromSite.sheetFilter));
      // activeTab is persisted for compatibility but boot always lands on
      // All ETFs so a reload restores catalog filters into the search box.
    }
  } catch {
    /* corrupt site-state */
  }
  try {
    Object.assign(filters, cleanTabFilters(JSON.parse(localStorage.getItem(SEARCHES_KEY) || 'null')));
  } catch {
    /* corrupt legacy searches */
  }
  try {
    Object.assign(filters, cleanTabFilters(JSON.parse(localStorage.getItem(FILTERS_KEY) || 'null')));
  } catch {
    /* corrupt filters key */
  }
  state.queryByTab = filters;
}

// =========================================================================
// 12. Bootstrap lifecycle
// =========================================================================

function bindEvents(): void {
  el.themeToggle.addEventListener('click', () => {
    const dark = !document.documentElement.classList.contains('dark');
    localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light');
    applyTheme(dark);
  });

  el.searchInput.addEventListener('input', () => {
    setCurrentQuery(el.searchInput.value.trim());
    updateSearchClearBtn();
    if (state.activeTab === 'watchlist') watchlistVisibleLimit = WATCHLIST_PAGE_SIZE;
    render();
  });

  el.searchClearBtn.addEventListener('click', () => {
    clearActiveSearchFilter();
  });

  bindColumnFilterEvents();
  el.copyBtn.addEventListener('click', copyTickers);
  el.exportCsvBtn.addEventListener('click', exportCsv);
  el.exportTxtBtn.addEventListener('click', exportTxt);
  el.resetBtn.addEventListener('click', clearSelectionAndSearch);

  el.blacklistBtn.addEventListener('click', () => {
    const visible = el.blacklistPanel.classList.toggle('is-visible');
    el.blacklistBtn.setAttribute('aria-expanded', String(visible));
    renderBlacklistPanel();
    fitTableHeight();
  });
  el.blacklistAddBtn.addEventListener('click', submitBlacklistInput);
  el.blacklistInput.addEventListener('keydown', (event: any) => {
    if (event.key === 'Enter') submitBlacklistInput();
  });
  el.blacklistClearBtn.addEventListener('click', clearBlacklist);

  // Paginated sheets: append more rows as the sentinel scrolls into view.
  if (typeof IntersectionObserver === 'function') {
    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) maybeLoadMoreRows();
      },
      { root: el.tableScroll, rootMargin: '600px 0px' },
    );
    observer.observe(el.staticLoadSentinel);
  }
  el.staticLoadSentinel.addEventListener('click', () => maybeLoadMoreRows());
  el.tableScroll.addEventListener('scroll', () => {
    const distanceToBottom = el.tableScroll.scrollHeight - el.tableScroll.scrollTop - el.tableScroll.clientHeight;
    if (state.activeTab === 'watchlist') {
      if (distanceToBottom < 600) maybeLoadMoreRows();
      return;
    }
    const sheet = activeSheetTab();
    if (!sheet || !state.activeFundTicker) return;
    const entry = sheetState.get(sheetKey(sheet));
    if (!entry || entry.loading || entry.nextPage >= entry.manifest.pages.length) return;
    if (distanceToBottom < 600) void loadNextSheetPage(sheet);
  }, { passive: true });

  // Keep only the table scrolling: refit on viewport changes and whenever
  // the content above the table (wrapping toolbar, panels) changes height.
  window.addEventListener('resize', fitTableHeight);
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => fitTableHeight()).observe(document.body);
  }
}

function init(): void {
  restoreSelectedEtfs();
  restoreBlacklist();
  restoreColumnFilters();
  restoreSearches();
  restoreTabSorts();
  applyTheme(localStorage.getItem(THEME_KEY) === 'dark');
  bindEvents();
  syncSearchInput();
  fitTableHeight();
  renderSubtitle();
  void loadCatalog().catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    el.tickerCount.textContent = 'Error';
    setStatusRow(`Unable to load api/spdr/index.json: ${message}. Run bun ./scripts/update-data.ts and serve the folder (for example bunx serve . -p 1234).`, 'error');
  });
}
