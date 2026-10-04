// Offline tests for the SPDR updater: five groups (controls, parsing, metrics, pipeline, network).
// XLSX fixtures are built in memory with a minimal STORE-method ZIP writer, so the suite needs no dependencies.
/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CONTROL_NAMES,
  RETURNS_BASIS,
  annualizedToTotal,
  applyHistoryRange,
  configurePacing,
  deriveCatalogMetrics,
  withYieldBasis,
  expenseRatios,
  fetchWithRetry,
  indicatedYield,
  installSystemCa,
  isCertError,
  loadConfig,
  loadSharedStrings,
  main,
  mergeOlderRows,
  normalizeHistoryRange,
  normalizeNumberText,
  paceRequests,
  parseAumRange,
  parseProductDataSheet,
  parseRange,
  parseXlsxSheet,
  resolveControls,
  rotateAfterCursor,
  runtimeControls,
  setApiRoot,
  setRequestTimeoutMs,
  setSoftDeadlineMs,
  sheetToTable,
  toIsoDate,
} from './update-data';

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let v = i;
    for (let bit = 0; bit < 8; bit++) v = v & 1 ? 0xedb88320 ^ (v >>> 1) : v >>> 1;
    table[i] = v >>> 0;
  }
  return table;
})();
const crc32 = (bytes: Uint8Array) => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

function buildZip(files: Map<string, Uint8Array>): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nameBytes = enc.encode(name);
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true); lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30); local.set(data, 30 + nameBytes.length);
    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true); cv.setUint16(28, nameBytes.length, true); cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    locals.push(local); centrals.push(central); offset += local.length;
  }
  const centralSize = centrals.reduce((sum, c) => sum + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.size, true); ev.setUint16(10, files.size, true);
  ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + 22);
  let at = 0;
  for (const chunk of [...locals, ...centrals, eocd]) { out.set(chunk, at); at += chunk.length; }
  return out;
}

const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function buildXlsx(rows: string[][]): Uint8Array {
  const enc = new TextEncoder();
  const body = rows
    .map((row, r) => `<row r="${r + 1}">${row.map((v, c) => `<c r="${String.fromCharCode(65 + c)}${r + 1}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`).join('')}</row>`)
    .join('');
  const sheet = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
  return buildZip(new Map([['xl/workbook.xml', enc.encode('<?xml version="1.0"?><workbook/>')], ['xl/worksheets/sheet1.xml', enc.encode(sheet)]]));
}
const table = (bytes: Uint8Array, kind: 'holdings' | 'history' | 'premium-discount') => sheetToTable(parseXlsxSheet(bytes, loadSharedStrings(bytes)), kind);

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const root = new URL('../', import.meta.url);
const configFile = () => JSON.parse(readFileSync(new URL('scripts/update-data.config.json', root), 'utf8')) as Record<string, string>;

// Environment, fetch, exit code, time zone and temp dirs are reset around every test.
const savedEnv = { ...process.env };
const savedFetch = globalThis.fetch;
const dirs: string[] = [];
beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    if ((CONTROL_NAMES as readonly string[]).includes(key.replace(/^SPDR_/, '')) || key === 'GITHUB_STEP_SUMMARY' || key === 'TZ') delete process.env[key];
  }
  process.env.TZ = 'UTC';
  process.exitCode = 0;
});
afterEach(() => {
  globalThis.fetch = savedFetch;
  process.exitCode = 0;
  setRequestTimeoutMs(45_000);
  setSoftDeadlineMs(25 * 60_000);
  configurePacing(1, 1, 2);
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  if (savedEnv.TZ === undefined) delete process.env.TZ;
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
describe('controls', () => {
  test('precedence: file < advanced < nonblank inputs < env < brand alias; empty env still wins', () => {
    const c = resolveControls({ CONCURRENCY: 2, TICKERS: 'SPY' }, { CONCURRENCY: 3, TICKERS: 'XLK' }, { CONCURRENCY: '4', TICKERS: '' }, { CONCURRENCY: '6' });
    expect(c.CONCURRENCY).toBe('6');
    expect(c.TICKERS).toBe('XLK'); // blank input does not clear advanced
    expect(resolveControls({ CONCURRENCY: 2 }, { CONCURRENCY: 3 }, { CONCURRENCY: '4' }).CONCURRENCY).toBe('4');
    expect(resolveControls({ CONCURRENCY: 2 }, {}, { CONCURRENCY: '' }).CONCURRENCY).toBe('2');
    expect(resolveControls({ MAX_RETRIES: 2 }, { MAX_RETRIES: 3 }, {}, { MAX_RETRIES: '' }).MAX_RETRIES).toBe('');
    expect(resolveControls({ VERBOSE: true }, {}, {}, { VERBOSE: 'false' }).VERBOSE).toBe('false');
  });

  test('brand env aliases work and the plain name beats the alias', () => {
    expect(resolveControls({ REQUEST_SLEEP: 1 }, {}, {}, { SPDR_REQUEST_SLEEP: '3' }).REQUEST_SLEEP).toBe('3');
    expect(resolveControls({ REQUEST_SLEEP: 1 }, {}, {}, { REQUEST_SLEEP: '2', SPDR_REQUEST_SLEEP: '3' }).REQUEST_SLEEP).toBe('2');
  });

  test('defaults: config file keys equal CONTROL_NAMES, scheduled path equals the file, runtimeControls reads it', async () => {
    const file = configFile();
    expect([...Object.keys(file)].sort()).toEqual([...CONTROL_NAMES].sort());
    for (const value of Object.values(file)) expect(typeof value).toBe('string');
    expect(file.USE_SYSTEM_CA).toBe('auto');
    expect(resolveControls(file, {}, {}, {})).toEqual(file);
    expect(await runtimeControls({})).toEqual(file);
    expect((await runtimeControls({ MAX_FETCHES: '5' })).MAX_FETCHES).toBe('5');
    const config = loadConfig(file);
    expect([config.tickers, config.maxFetches, config.concurrency, config.maxRetries, config.historyRange]).toEqual([[], 0, 2, 2, 'max']);
    expect([config.aumRange, config.terRange, config.secYieldRange, config.dividendYieldRange]).toEqual([undefined, undefined, undefined, undefined]);
    expect([config.performanceRanges, config.totalReturnRanges]).toEqual([{}, {}]);
  });

  test('strict validation: bad values throw, never fall back silently', () => {
    const bad: Record<string, string | number>[] = [
      { CONCURRENCY: 0 }, { MAX_RETRIES: 0 }, { MAX_RETRIES: -1 }, { MAX_FETCHES: 1.5 }, { REQUEST_SLEEP: '-1' }, { REQUEST_SLEEP: 'fast' },
      { HOLDINGS_PAGE_SIZE: '-5' }, { HISTORY_PAGE_SIZE: '1.5' }, { HISTORY_RANGE: '0y' }, { HISTORY_RANGE: 'forever' },
      { DIVIDEND_YIELD: '3' }, { SEC_YIELD: '5:1' }, { AUM: '1:2:3' }, { TER: '5' }, { PERFORMANCE_1Y: '9:1' },
      { VERBOSE: 'maybe' }, { STORE_RAW_DOWNLOADS: 'maybe' }, { USE_SYSTEM_CA: 'maybe' }, { UNKNOWN: 1 }, { OUTPUT_DIR: 'x' },
      { TICKERS: 'SPY\nEVIL=yes' }, { TICKERS: 'A\rB' }, { TICKERS: 'A\0B' },
    ];
    for (const value of bad) expect(() => resolveControls(value)).toThrow();
    for (const value of [null, [], { TICKERS: ['SPY'] }, { TICKERS: { a: 1 } }]) expect(() => resolveControls(value)).toThrow();
    expect(() => resolveControls({}, {}, {}, { TICKERS: 'x\0bad' })).toThrow();
    for (const v of ['auto', 'TRUE', 'False']) expect(resolveControls({}, {}, {}, { USE_SYSTEM_CA: v }).USE_SYSTEM_CA).toBe(v);
    for (const b of [{ CONCURRENCY: 'abc' }, { MAX_FETCHES: 'x' }, { MAX_RETRIES: '0' }, { STORE_RAW_DOWNLOADS: 'maybe' }]) expect(() => loadConfig(b)).toThrow();
    expect(loadConfig({ STORE_RAW_DOWNLOADS: 'off' }).storeRawDownloads).toBe(false);
  });

  test('range parsers: bounds, K/M/B/T and presets, percent signs, rejection of colonless or inverted values', () => {
    for (const empty of ['', ':', '  :  ']) expect(parseRange(empty, 'X')).toBeUndefined();
    expect(parseRange('5:20', 'X')).toEqual({ min: 5, max: 20 });
    expect(parseRange('5:', 'X')).toEqual({ min: 5, max: undefined });
    expect(parseRange(':20', 'X')).toEqual({ min: undefined, max: 20 });
    expect(parseRange('1%:4.5%', 'X')).toEqual({ min: 1, max: 4.5 });
    for (const bad of ['5', '1:2:3', '20:5']) expect(() => parseRange(bad, 'X')).toThrow();
    expect(parseAumRange('')).toBeUndefined();
    expect(parseAumRange('300M:2B')).toEqual({ source: '300M:2B', min: 300_000_000, max: 2_000_000_000, maxExclusive: false });
    expect(parseAumRange('1M:')).toEqual({ source: '1M:', min: 1_000_000 }); // a lone lower bound is not also the upper one
    const preset = parseAumRange('micro:small') as any;
    expect([preset.min, preset.max, preset.maxExclusive]).toEqual([10_000_000, 2_000_000_000, true]);
    for (const bad of ['mid', '123456789', 'all']) expect(() => parseAumRange(bad)).toThrow();
  });

  test('HISTORY_RANGE: normalized strictly and trims dated rows (same result east and west of UTC)', () => {
    expect(normalizeHistoryRange('')).toBe('max');
    expect(normalizeHistoryRange(' MAX ')).toBe('max');
    expect(normalizeHistoryRange('5Y')).toBe('5y');
    expect(normalizeHistoryRange('18mo')).toBe('18mo');
    for (const bad of ['0y', '5', 'y', '-1y', '5 years']) expect(() => normalizeHistoryRange(bad)).toThrow();
    // dates are relative to now so the test does not age: 1 month, 8 months, 3 years old
    const ago = (days: number) => { const d = new Date(Date.now() - days * 86_400_000); return `${String(d.getUTCDate()).padStart(2, '0')}-${MON[d.getUTCMonth()]}-${d.getUTCFullYear()}`; };
    const data = { headers: ['Date', 'NAV'], rows: [[ago(30), '3'], [ago(240), '2'], [ago(1100), '1'], ['bad-date', '0']] };
    expect(applyHistoryRange(data, 'max')).toBe(data);
    for (const tz of ['Pacific/Kiritimati', 'America/Los_Angeles']) {
      process.env.TZ = tz;
      expect(toIsoDate('Jun 04 2026')).toBe('2026-06-04');
      expect(applyHistoryRange(data, '1y').rows.map((r) => r[1])).toEqual(['3', '2', '0']); // undated rows are kept
      expect(applyHistoryRange(data, '6mo').rows.map((r) => r[1])).toEqual(['3', '0']);
            expect(applyHistoryRange(data, '5y').rows).toHaveLength(4);
    }
  });

  test('USE_SYSTEM_CA: certificate errors are recognized and only they trigger the restart', async () => {
    expect(isCertError({ code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' })).toBe(true);
    expect(isCertError(new Error('fetch failed', { cause: new Error('self-signed certificate in certificate chain') }))).toBe(true);
    expect(isCertError({ code: 'ECONNRESET', message: 'socket hang up' })).toBe(false);
    expect(isCertError(new Error('HTTP 403 rate limited'))).toBe(false);
    let calls = 0;
    const reexec = (() => { calls++; throw new Error('reexec'); }) as () => never;
    installSystemCa('false', reexec, false);
    installSystemCa('auto', reexec, true);
    expect(globalThis.fetch).toBe(savedFetch);
    expect(() => installSystemCa('true', reexec, false)).toThrow('reexec');
    let mode: 'ok' | 'cert' | 'net' = 'ok';
    globalThis.fetch = (async () => {
      if (mode === 'cert') throw new Error('fetch failed', { cause: { code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' } });
      if (mode === 'net') throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      return new Response('ok');
    }) as unknown as typeof fetch;
    calls = 0;
    installSystemCa('auto', reexec, false);
    expect(await (await fetch('http://x.test')).text()).toBe('ok');
    mode = 'net';
    await expect(fetch('http://x.test')).rejects.toThrow('socket hang up');
    expect(calls).toBe(0);
    mode = 'cert';
    await expect(fetch('http://x.test')).rejects.toThrow('reexec');
    expect(calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('parsing', () => {
  test('number text: scientific notation is expanded, plain text is untouched', () => {
    expect(normalizeNumberText('2.97057744E8')).toBe('297057744');
    expect(normalizeNumberText('5.84E7')).toBe('58400000');
    for (const same of ['7.865622', 'NVIDIA CORP', '12/31/2030', '-']) expect(normalizeNumberText(same)).toBe(same);
  });

  test('equity and bond holdings workbooks', () => {
    const equity = table(buildXlsx([
      ['Fund Name:', 'State Street SPDR S&P 500 ETF Trust'], ['Ticker Symbol:', 'SPY'], ['Holdings:', 'As of 21-Aug-2026'],
      ['Name', 'Ticker', 'Identifier', 'SEDOL', 'Weight', 'Sector', 'Shares Held', 'Local Currency'],
      ['NVIDIA CORP', 'NVDA', '67066G104', '2379504', '7.865622', '-', '2.97057744E8', 'USD'],
      ['APPLE INC', 'AAPL', '037833100', '2046251', '6.871781', '-', '1.80135563E8', 'USD'],
    ]), 'holdings');
    expect([equity.meta.fundName, equity.meta.ticker, equity.meta.asOfDate]).toEqual(['State Street SPDR S&P 500 ETF Trust', 'SPY', '21-Aug-2026']);
    expect(equity.table.rows).toHaveLength(2);
    expect([equity.table.rows[0][0], equity.table.rows[0][6], equity.table.rows[1][1]]).toEqual(['NVIDIA CORP', '297057744', 'AAPL']);
    const bond = table(buildXlsx([
      ['Fund Name:', 'SPDR Portfolio Aggregate Bond ETF'], ['Ticker Symbol:', 'SPAB'], ['Holdings:', 'As of 21-Aug-2026'],
      ['Name', 'Identifier', 'SEDOL', 'Weight', 'Coupon', 'Par Value', 'Market Value', 'Local Currency', 'Maturity'],
      ['US TREASURY N/B 12/28 3.5', 'US91282CPP04', 'BWH3WF4', '0.737304', '3.5', '7.7E7', '7.571265625E7', 'USD', '12/15/2028'],
    ]), 'holdings');
    expect(bond.table.headers).not.toContain('Ticker');
    expect(bond.table.rows[0][5]).toBe('77000000');
  });

  test('NAV and premium/discount history workbooks (blank rows dropped, registered mark stripped)', () => {
    const nav = table(buildXlsx([
      ['Fund Name:', 'SPDR Gold MiniShares'], ['Ticker Symbol:', 'GLDM®'], ['Date', 'NAV', 'Shares Outstanding', 'Total Net Assets'],
      ['21-Aug-2026', '765.579524', '1.071332116E9', '8.2018993105119E11'], ['20-Aug-2026', '762.237019', '1.072982116E9', '8.1786669002065E11'],
    ]), 'history');
    expect(nav.meta.ticker).toBe('GLDM');
    expect(nav.table.headers).toEqual(['Date', 'NAV', 'Shares Outstanding', 'Total Net Assets']);
    expect(nav.table.rows).toHaveLength(2);
    expect([nav.table.rows[0][1], nav.table.rows[0][2]]).toEqual(['765.579524', '1071332116']);
    const pd = table(buildXlsx([
      ['Fund Name:', 'SPDR S&P 500'], ['Ticker Symbol:', 'SPY'], ['Date', 'Premium/Discount'],
      ['23-Sep-2026', '0.021463'], ['22-Sep-2026', '-0.004259'], ['', ''],
    ]), 'premium-discount');
    expect(pd.table.rows).toEqual([['23-Sep-2026', '0.021463'], ['22-Sep-2026', '-0.004259']]);
    expect(loadSharedStrings(buildXlsx([['A1']]))).toEqual([]);
  });

  test('bulk product data: ISIN/CUSIP/yields, "-" and absent columns become null, junk rows skipped, no header throws', () => {
    const map = parseProductDataSheet(buildXlsx([
      ['Past performance is not a reliable indicator of future performance.'],
      ['Ticker', 'ISIN', 'CUSIP', 'Gross Expense Ratio', '* Net Expense Ratio', '30 Day SEC Yield', '30 Day SEC Yield (Unsubsidized)', 'Fund Dividend Yield', 'Index Dividend Yield', 'Total Returns (Cumulative)', '', 'Total Returns (Annualized)', ''],
      ['', '', '', '', '', '', '', '', '', '1 Month', 'QTD', '1 Year', '3 Year'],
      ['SPY', 'US78462F1030', '78462F103', '0.0945%', '-', '0.95%', '-', '0.99%', '1.09%', '2.71%', '2.64%', '20.21%', '20.89%'],
      ['XLK', 'US81369Y8030', '81369Y803', '0.08%', '-', '-', '-', '0.55%', '0.60%', '5.00%', '6.00%', '30.00%', '25.00%'],
      ['', '', '', '', '', '', '', '', '', '', '', '', ''],
    ]));
    expect(map.size).toBe(2);
    const spy = map.get('SPY')!;
    expect([spy.isin, spy.cusip]).toEqual(['US78462F1030', '78462F103']);
    expect(spy.netExpenseRatio).toEqual({ display: null, value: null });
    expect(spy.secYield).toEqual({ display: '0.95%', value: 0.95 });
    expect(spy.secYieldUnsubsidized).toEqual({ display: null, value: null });
    expect(spy.fundDividendYield).toEqual({ display: '0.99%', value: 0.99 });
    expect(map.get('XLK')!.secYield).toEqual({ display: null, value: null });
    const sparse = parseProductDataSheet(buildXlsx([['disclaimer'], ['Ticker', 'ISIN', 'CUSIP'], ['GLDM', 'US98149E3036', '98149E303'], ['', '', '']]));
    expect(sparse.size).toBe(1);
    expect(sparse.get('GLDM')!.secYield).toEqual({ display: null, value: null }); // column absent
    expect(() => parseProductDataSheet(buildXlsx([['not', 'a', 'header', 'row']]))).toThrow();
  });

  test('dates: SSGA formats normalize to ISO, garbage becomes null', () => {
    for (const ok of ['Aug 31 2026', '08/31/2026', '2026-08-31']) expect(toIsoDate(ok)).toBe('2026-08-31');
    for (const bad of ['Feb 30 2026', '', null, '-']) expect(toIsoDate(bad)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('metrics', () => {
  const monthEnd = { ytd: 10.06, yr1: 19.4, yr3: 19.18, yr5: 12.72, yr10: 14.93, sinceInception: 10.8 };

  test('annualized -> total conversion, null (never 0) on bad input', () => {
    expect(annualizedToTotal(19.18, 3)).toBeCloseTo(69.28, 2);
    expect(annualizedToTotal(14.93, 10)).toBeCloseTo(302.1, 1);
    expect(annualizedToTotal(-100, 5)).toBe(-100);
    for (const [value, years] of [[null, 3], [Number.NaN, 3], [10, 0]] as const) expect(annualizedToTotal(value, years)).toBeNull();
  });

  test('indicated yield: frequency multiplier (semi-annual is 2), null when any piece is missing', () => {
    expect(indicatedYield({ frequency: 'Quarterly', dividend: '1.903516' }, 765.58)).toBeCloseTo(0.9945, 3);
    expect(indicatedYield({ frequency: 'Monthly', dividend: '0.10' }, 25)).toBeCloseTo(4.8, 3);
    expect(indicatedYield({ frequency: 'Semi-Annually', dividend: '1.00' }, 100)).toBe(2);
    expect(indicatedYield({ frequency: 'Annually', dividend: '2.00' }, 100)).toBe(2);
    expect(indicatedYield(null, 100)).toBeNull();
    expect(indicatedYield({ frequency: 'Quarterly' }, 100)).toBeNull();
    expect(indicatedYield({ frequency: 'Quarterly', dividend: 'n/a' }, 100)).toBeNull();
    expect(indicatedYield({ frequency: 'Quarterly', dividend: '1.00' }, null)).toBeNull();
    expect(indicatedYield({ frequency: 'Weekly', dividend: '1.00' }, 100)).toBeNull();
  });

  test('CAGRs map directly, total returns are derived, official yields win over the indicated one', () => {
    const dist = { frequency: 'Quarterly', exDate: '06/18/2026', dividend: '1.903516' };
    const plain = deriveCatalogMetrics(monthEnd, 765.58, dist);
    expect([plain.cagr3y, plain.cagr5y, plain.cagr10y, plain.siAnn]).toEqual([19.18, 12.72, 14.93, 10.8]);
    expect(plain.tr3y).toBeCloseTo(69.28, 2);
    expect(plain.tr3yText).toBe('69.28%');
    expect(plain.dividendYieldSource).toBe('indicated');
    expect(plain.secYield).toBeNull();
    const none = { display: null, value: null };
    const official = deriveCatalogMetrics(monthEnd, 765.58, dist, {
      isin: 'US78462F1030', cusip: '78462F103', netExpenseRatio: none, secYield: { display: '0.95%', value: 0.95 }, secYieldUnsubsidized: none,
      fundDividendYield: { display: '0.99%', value: 0.99 }, indexDividendYield: { display: '1.09%', value: 1.09 },
    } as any);
    expect([official.secYield, official.secYieldText, official.secYieldUnsubsidized]).toEqual([0.95, '0.95%', null]);
    expect([official.dividendYield, official.dividendYieldText, official.dividendYieldSource]).toEqual([0.99, '0.99%', 'official']);
    expect(official.indicatedDividendYield).toBeCloseTo(0.9945, 3);
  });

  test('dividendYieldBasis: code per yield source, null with a null yield, same key set on fresh/legacy/empty rows', () => {
    const dist = { frequency: 'Quarterly', exDate: '06/18/2026', dividend: '1.903516' };
    const none = { display: null, value: null };
    const pd = { fundDividendYield: { display: '0.99%', value: 0.99 }, secYield: none, secYieldUnsubsidized: none } as any;
    const official = deriveCatalogMetrics(monthEnd, 765.58, dist, pd);
    const indicated = deriveCatalogMetrics(monthEnd, 765.58, dist);
    const zero = deriveCatalogMetrics(monthEnd, 765.58, dist, { ...pd, fundDividendYield: { display: '0.00%', value: 0 } });
    const nothing = deriveCatalogMetrics({ ytd: 1 }, 20, null);
    expect([official.dividendYieldBasis, indicated.dividendYieldBasis, zero.dividendYieldBasis, nothing.dividendYieldBasis]).toEqual(['official-other', 'indicated', 'official-other', null]);
    expect(nothing.dividendYield).toBeNull();
    const legacy = withYieldBasis({ dividendYield: 0.99, dividendYieldSource: 'official', dividendYieldText: '0.99%' });
    const legacyEmpty = withYieldBasis({ dividendYield: null, dividendYieldSource: null });
    expect([legacy.dividendYieldBasis, legacyEmpty.dividendYieldBasis, withYieldBasis(null).dividendYieldBasis]).toEqual(['official-other', null, null]);
    expect(Object.keys(legacy)).toEqual(['dividendYield', 'dividendYieldSource', 'dividendYieldBasis', 'dividendYieldText']);
    const keys = Object.keys(official).sort();
    for (const m of [indicated, zero, nothing]) expect(Object.keys(m).sort()).toEqual(keys);
    expect(withYieldBasis(official)).toEqual(official);
  });

  test('young funds and commodity trusts: missing horizons are null, never 0; siAnn needs a year of history', () => {
    const young = deriveCatalogMetrics({ ytd: 5, yr1: 17.22, sinceInception: 15.08 }, 20.5, null);
    expect([young.tr3y, young.tr3yText, young.cagr10y, young.dividendYield, young.dividendYieldSource]).toEqual([null, null, null, null, null]);
    expect(young.tr1y).toBe(17.22);
    const empty = deriveCatalogMetrics({ asOfDate: null, ytd: null }, 20, null);
    expect([empty.ytd, empty.tr1y, empty.cagr3y, empty.performanceAsOf]).toEqual([null, null, null, null]);
    const base = { asOfDate: 'Aug 31 2026', ytd: 1, sinceInception: 4.2 };
    expect(deriveCatalogMetrics({ ...base, inceptionDate: 'Feb 10 2026' }, 10, null).siAnn).toBeNull();
    expect(deriveCatalogMetrics({ ...base, inceptionDate: 'Aug 31 2025' }, 10, null).siAnn).toBe(4.2);
    expect(deriveCatalogMetrics({ ...base, inceptionDate: 'Sep 01 2025' }, 10, null).siAnn).toBeNull();
  });

  test('returnsBasis and performanceAsOf travel together at the end of every metrics object', () => {
    const full = deriveCatalogMetrics({ asOfDate: 'Aug 31 2026', ytd: 9.29, yr1: 17.71 }, 29.06, null);
    expect(Object.keys(full).slice(-2)).toEqual(['returnsBasis', 'performanceAsOf']);
    expect(full.returnsBasis).toBe(RETURNS_BASIS);
    expect(String(full.returnsBasis).trim()).not.toBe('');
    expect(full.performanceAsOf).toBe('2026-08-31'); // month-end date, not the NAV date
    const young = deriveCatalogMetrics({ asOfDate: null, ytd: null }, 20, null);
    expect(Object.keys(young)).toEqual(Object.keys(full));
    expect([young.returnsBasis, young.performanceAsOf]).toEqual([RETURNS_BASIS, null]);
  });

  test('TER: terValue is the net ratio, terGrossValue the gross one, with fallbacks', () => {
    const fund = { ter: '0.10%', terValue: 0.1 };
    const gross = { display: '0.18%', value: 0.18 };
    expect(expenseRatios(fund, { grossExpenseRatio: gross, netExpenseRatio: { display: '0.08%', value: 0.08 } } as any)).toEqual({ ter: '0.08%', terValue: 0.08, terGross: '0.18%', terGrossValue: 0.18 });
    expect(expenseRatios(fund, { grossExpenseRatio: gross, netExpenseRatio: { display: null, value: null } } as any)).toEqual({ ter: '0.18%', terValue: 0.18, terGross: '0.18%', terGrossValue: 0.18 });
    expect(expenseRatios(fund, null)).toEqual({ ter: '0.10%', terValue: 0.1, terGross: '0.10%', terGrossValue: 0.1 });
  });
});

// ---------------------------------------------------------------------------
// Mocked SSGA: catalog of 3 funds (GLD is a commodity trust without a holdings file)

const DAY = 86_400_000;
const NEWEST = Date.UTC(2026, 8, 30);
const dmy = (t: number) => { const d = new Date(t); return `${String(d.getUTCDate()).padStart(2, '0')}-${MON[d.getUTCMonth()]}-${d.getUTCFullYear()}`; };
const historySheet = (ticker: string, n: number) => [['Fund Name:', `${ticker} fund`], ['Ticker Symbol:', ticker], [''], ['Date', 'NAV', 'Shares Outstanding', 'Total Net Assets'],
  ...Array.from({ length: n }, (_, i) => [dmy(NEWEST - i * 2 * DAY), String(100 + i / 10), '1', '1'])];
const pdSheet = (n: number) => [['Date', 'Premium/Discount'], ...Array.from({ length: n }, (_, i) => [dmy(NEWEST - i * 2 * DAY), '0.01'])];
const holdingsSheet = (t: string) => [['Fund Name:', `${t} fund`], ['Ticker Symbol:', t], ['As of', '30-Sep-2026'], ['Name', 'Identifier', 'Weight', 'Sector', 'Shares Held'], ['ACME', 'AC1', '50', 'Tech', '10']];
const productSheet = [['Ticker', 'ISIN', 'CUSIP', 'Gross Expense Ratio', '* Net Expense Ratio', '30 Day SEC Yield', '30 Day SEC Yield (Unsubsidized)', 'Fund Dividend Yield', 'Index Dividend Yield'],
  ['SPY', 'US1', 'C1', '0.0945%', '0.0800%', '0.95%', '-', '1.00%', '1.10%'], ['XLK', 'US2', 'C2', '0.08%', '-', '-', '-', '0.55%', '0.60%'], ['GLD', 'US3', 'C3', '0.40%', '-', '-', '-', '0.00%', '-']];

type Mock = { tickers: string[]; nav: Record<string, number>; hist: number; failNavhist: Set<string>; latency: number; inflight: number; peak: number };
function fundRecord(ticker: string, nav: number) {
  const record: Record<string, unknown> = { fundTicker: ticker, fundName: `${ticker} ETF`, fundUri: `/etfs/${ticker.toLowerCase()}`, ter: ['0.10%', 0.1], nav: [`$${nav}`, nav], aum: ['$1,000 M', 1000], asOfDate: ['Sep 30 2026', 0], closePrice: ['$1', 1], premiumDiscount: ['0.01%', 0.01], inceptionDate: ['Jan 22 1993', 0] };
  for (const [suffix, date] of [['', 'Aug 31 2026'], ['_1', 'Jun 30 2026']]) {
    record[`PerfAsOf${suffix}`] = [date, 0];
    for (const key of ['mo1', 'qtd', 'ytd', 'yr1', 'yr3', 'yr5', 'yr10', 'sinceInception']) record[`${key}${suffix}`] = ['5.00%', 5];
  }
  return record;
}
function installMock(overrides: Partial<Mock> = {}): Mock {
  const mock: Mock = { tickers: ['SPY', 'XLK', 'GLD'], nav: { SPY: 500, XLK: 200, GLD: 300 }, hist: 300, failNavhist: new Set(), latency: 0, inflight: 0, peak: 0, ...overrides };
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    mock.inflight++; mock.peak = Math.max(mock.peak, mock.inflight);
    try {
      if (mock.latency) await new Promise((r) => setTimeout(r, mock.latency));
      const xlsx = (rows: string[][]) => new Response(new Uint8Array(buildXlsx(rows)));
      if (url.includes('fundfinder')) return Response.json({ data: { funds: { etfs: { categories: [], datas: mock.tickers.map((t) => fundRecord(t, mock.nav[t])) } } } });
      if (url.includes('dividend-distribution')) return Response.json({ data: [] });
      if (url.includes('product-data')) return xlsx(productSheet);
      const m = /(holdings-daily|navhist|pdhist)-us-en-([a-z]+)\.xlsx/.exec(url);
      if (!m) return new Response('no', { status: 404 });
      const ticker = m[2].toUpperCase();
      if (m[1] === 'holdings-daily') return ticker === 'GLD' ? new Response('nf', { status: 404 }) : xlsx(holdingsSheet(ticker));
      if (m[1] === 'navhist') return mock.failNavhist.has(ticker) ? new Response('err', { status: 500 }) : xlsx(historySheet(ticker, mock.hist));
      return xlsx(pdSheet(mock.hist));
    } finally { mock.inflight--; }
  }) as unknown as typeof fetch;
  return mock;
}
const tempRoot = () => {
  const dir = mkdtempSync(join(tmpdir(), 'spdr-test-'));
  dirs.push(dir);
  setApiRoot(pathToFileURL(`${dir}/`));
  return dir;
};
const readJson = (dir: string, path: string) => JSON.parse(readFileSync(join(dir, path), 'utf8'));
const listFiles = (dir: string, prefix = ''): string[] =>
  readdirSync(join(dir, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) => (e.isDirectory() ? listFiles(dir, `${prefix}${e.name}/`) : [`${prefix}${e.name}`]));
const runMain = async (env: Record<string, string> = {}) => {
  const log = console.log;
  console.log = () => {};
  try { await main({ REQUEST_SLEEP: '0', MAX_RETRIES: '1', USE_SYSTEM_CA: 'false', CONCURRENCY: '1', ...env }); } finally { console.log = log; }
};
const row = (dir: string, ticker: string) => readJson(dir, 'index.json').funds.find((f: any) => f.ticker === ticker);

// ---------------------------------------------------------------------------
describe('pipeline', () => {
  test('commodity trust without holdings (GLD) still gets meta.json, empty holdings and the same metrics keys', async () => {
    const dir = tempRoot();
    installMock();
    await runMain();
    const gld = row(dir, 'GLD');
    expect(gld.dataFile).toBe('./funds/GLD/meta.json');
    expect(readJson(dir, 'funds/GLD/meta.json').holdings.status).toBe('empty');
    expect(gld.holdingsStatus).toBe('empty');
    expect(Object.keys(gld.metrics)).toEqual(Object.keys(row(dir, 'SPY').metrics));
    for (const f of readJson(dir, 'index.json').funds) if (f.dataFile) expect(existsSync(join(dir, f.dataFile))).toBe(true);
  });

  test('a fund that never got a meta.json is listed with dataFile null and a full metrics object', async () => {
    const dir = tempRoot();
    installMock({ failNavhist: new Set(['XLK']) });
    await runMain();
    const xlk = row(dir, 'XLK');
    expect(xlk.dataFile).toBeNull();
    expect(Object.keys(xlk.metrics)).toEqual(Object.keys(row(dir, 'SPY').metrics));
    expect(xlk.metrics.returnsBasis).toBe(RETURNS_BASIS);
  });

  test('a one-ticker run keeps every catalog row and the files of unselected funds', async () => {
    const dir = tempRoot();
    installMock();
    await runMain();
    const before = readJson(dir, 'index.json').funds;
    const xlkMeta = readFileSync(join(dir, 'funds/XLK/meta.json'), 'utf8');
    installMock({ nav: { SPY: 501, XLK: 999, GLD: 300 } });
    await runMain({ TICKERS: 'SPY' });
    const after = readJson(dir, 'index.json').funds;
    expect(after.map((f: any) => f.ticker)).toEqual(before.map((f: any) => f.ticker));
    expect(after).toHaveLength(3);
    expect(row(dir, 'SPY').navValue).toBe(501);
    expect(row(dir, 'XLK')).toEqual(before.find((f: any) => f.ticker === 'XLK'));
    expect(readFileSync(join(dir, 'funds/XLK/meta.json'), 'utf8')).toBe(xlkMeta);
  });

  test('a second identical run writes nothing (same files, bytes and mtimes, no temp files)', async () => {
    const dir = tempRoot();
    installMock();
    await runMain();
    const old = new Date('2001-01-01T00:00:00Z');
    for (const f of listFiles(dir)) utimesSync(join(dir, f), old, old);
    const snap = () => listFiles(dir).map((f) => `${f}:${statSyncMtime(join(dir, f))}:${readFileSync(join(dir, f), 'utf8')}`);
    const before = snap();
    await runMain();
    expect(snap()).toEqual(before);
    expect(listFiles(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  test('a fund whose source failed keeps its previous index row and meta exactly as published', async () => {
    const dir = tempRoot();
    installMock();
    await runMain();
    const meta = readFileSync(join(dir, 'funds/SPY/meta.json'), 'utf8');
    const prev = row(dir, 'SPY');
    installMock({ nav: { SPY: 777, XLK: 200, GLD: 300 }, failNavhist: new Set(['SPY']) });
    await runMain();
    expect(row(dir, 'SPY')).toEqual(prev);
    expect(prev.navValue).toBe(500);
    expect(readFileSync(join(dir, 'funds/SPY/meta.json'), 'utf8')).toBe(meta);
  });

  test('unknown TICKERS is an error that writes nothing; all selected funds failing is an error', async () => {
    const dir = tempRoot();
    installMock();
    await expect(runMain({ TICKERS: 'XXXX' })).rejects.toThrow(/unknown ticker/);
    expect(existsSync(join(dir, 'index.json'))).toBe(false);
    installMock({ failNavhist: new Set(['SPY', 'XLK', 'GLD']) });
    await expect(runMain({ CONCURRENCY: '3' })).rejects.toThrow(/all 3 selected funds failed/);
  }, 20_000);

  test('HISTORY_RANGE shorter than the published history keeps older pages and rows; mergeOlderRows keeps order', async () => {
    const dir = tempRoot();
    installMock({ hist: 400 });
    await runMain({ HISTORY_PAGE_SIZE: '100', TICKERS: 'SPY' });
    expect(listFiles(dir, 'funds/SPY/history/')).toHaveLength(4);
    await runMain({ HISTORY_PAGE_SIZE: '100', TICKERS: 'SPY', HISTORY_RANGE: '1y' });
    expect(listFiles(dir, 'funds/SPY/history/')).toHaveLength(4);
    expect(readJson(dir, 'funds/SPY/meta.json').history.totalRows).toBe(400);
    expect(readJson(dir, 'funds/SPY/meta.json').premiumDiscountHistory.totalRows).toBe(400);
    expect(row(dir, 'SPY').history).toBe(400);
    mkdirSync(join(dir, 'funds/X/history'), { recursive: true });
    const headers = ['Date', 'NAV'];
    writeFileSync(join(dir, 'funds/X/history/001.json'), JSON.stringify({ headers, rows: [{ Date: '05-Jan-2026', NAV: '3' }, { Date: '04-Jan-2025', NAV: '2' }, { Date: '03-Jan-2024', NAV: '1' }] }));
    const merged = await mergeOlderRows(new URL(`${pathToFileURL(dir).href}/funds/X/`), 'history', { headers, rows: [['05-Jan-2026', '3'], ['06-Jun-2025', '2.5']] });
    expect(merged.rows.map((r) => r[0])).toEqual(['05-Jan-2026', '06-Jun-2025', '04-Jan-2025', '03-Jan-2024']);
  });

  test('bounded cursor: MAX_FETCHES advances it, a TICKERS run leaves it alone, rotation wraps', async () => {
    const dir = tempRoot();
    installMock();
    await runMain({ MAX_FETCHES: '2' });
    expect(readJson(dir, 'update-state.json').lastProcessedTicker).toBe('SPY');
    const saved = readFileSync(join(dir, 'update-state.json'), 'utf8');
    await runMain({ MAX_FETCHES: '1', TICKERS: 'XLK' });
    expect(readFileSync(join(dir, 'update-state.json'), 'utf8')).toBe(saved);
    await runMain({ MAX_FETCHES: '1', AUM: '1M:' });
    expect(readJson(dir, 'update-state.json').lastProcessedTicker).toBe('GLD');
    const funds = ['A', 'C', 'E'].map((ticker) => ({ ticker }));
    const order = (c: string | null) => rotateAfterCursor(funds, c).map((f) => f.ticker);
    expect(order('C')).toEqual(['E', 'A', 'C']);
    expect(order('D')).toEqual(['E', 'A', 'C']);
    expect(order('E')).toEqual(['A', 'C', 'E']);
    expect(order(null)).toEqual(['A', 'C', 'E']);
  });

  test('soft deadline: no new funds are started, the index is still written', async () => {
    const dir = tempRoot();
    setSoftDeadlineMs(-1);
    installMock();
    await runMain();
    expect(readJson(dir, 'index.json').funds).toHaveLength(3);
    expect(existsSync(join(dir, 'funds/SPY/meta.json'))).toBe(false);
  });
});

function statSyncMtime(path: string): number {
  return statSync(path).mtimeMs;
}

// ---------------------------------------------------------------------------
// Resolves to 'hung' when the promise is still pending after `ms`, so a missing timeout fails fast instead of hanging bun.
const settled = (p: Promise<unknown>, ms = 3000) =>
  Promise.race([p.then((v) => (typeof v === 'string' ? v : 'resolved'), () => 'rejected'), new Promise<string>((r) => setTimeout(() => r('hung'), ms))]);

describe('network', () => {
  test('a stalled connection (headers never arrive) is aborted by the timeout', async () => {
    setRequestTimeoutMs(100);
    configurePacing(0, 1, 0);
    globalThis.fetch = ((_: unknown, init?: RequestInit) => new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof fetch;
    expect(await settled(fetchWithRetry('http://x.test/a', 'stall'))).toBe('rejected');
  });

  test('a stalled body (headers fine, body never ends) is aborted and retried', async () => {
    setRequestTimeoutMs(100);
    configurePacing(0, 1, 1);
    let calls = 0;
    globalThis.fetch = ((_: unknown, init?: RequestInit) => {
      calls++;
      if (calls > 1) return Promise.resolve(new Response('ok'));
      const body = new ReadableStream({ start(c) { init?.signal?.addEventListener('abort', () => c.error(new Error('aborted'))); } });
      return Promise.resolve(new Response(body));
    }) as unknown as typeof fetch;
    expect(await settled(fetchWithRetry('http://x.test/b', 'stall-body').then((r) => r.text()), 8000)).toBe('ok'); // includes the 3 s retry back-off
    expect(calls).toBe(2);
  }, 15_000);

  test('retries are bounded: MAX_RETRIES=1 means two attempts, then the error surfaces', async () => {
    configurePacing(0, 1, 1);
    let calls = 0;
    globalThis.fetch = (async () => { calls++; throw new Error('boom'); }) as unknown as typeof fetch;
    await expect(fetchWithRetry('http://x.test/c', 'bounded')).rejects.toThrow('boom');
    expect(calls).toBe(2);
    calls = 0;
    configurePacing(0, 1, 0);
    await expect(fetchWithRetry('http://x.test/c', 'bounded')).rejects.toThrow('boom');
    expect(calls).toBe(1);
  }, 15_000);

  test('pacing: simultaneous callers on one lane get spaced slots instead of a burst', async () => {
    configurePacing(0.15, 1);
    const t0 = Date.now();
    const starts: number[] = [];
    await Promise.all([0, 1, 2].map(async () => { await paceRequests(); starts.push(Date.now() - t0); }));
    starts.sort((a, b) => a - b);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(100);
    expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(100);
  });

  test('in-flight counter: peak 1 at CONCURRENCY=1, peak N at CONCURRENCY=N', async () => {
    for (const [concurrency, expected] of [['1', 1], ['3', 3]] as const) {
      tempRoot();
      const mock = installMock({ latency: 25 });
      await runMain({ CONCURRENCY: concurrency });
      expect(mock.peak).toBe(expected);
    }
  });
});
