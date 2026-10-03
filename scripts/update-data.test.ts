// Tests for the SPDR static data updater helpers (Bun test runner).
// The XLSX fixtures are built in memory with a minimal STORE-method ZIP writer,
// so the test suite stays dependency-free like the updater itself.
/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync, mkdtempSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CONTROL_NAMES,
  installSystemCa,
  isCertError,
  loadConfig,
  resolveControls,
  runtimeControls,
  normalizeHistoryRange,
  applyHistoryRange,
  parseRange,
  parseAumRange,
  normalizeNumberText,
  parseXlsxSheet,
  loadSharedStrings,
  sheetToTable,
  annualizedToTotal,
  indicatedYield,
  deriveCatalogMetrics,
  RETURNS_BASIS,
  toIsoDate,
  parseProductDataSheet,
  main,
  setApiRoot,
  setRequestTimeoutMs,
  setSoftDeadlineMs,
  configurePacing,
  paceRequests,
  fetchWithRetry,
  mergeOlderRows,
  rotateAfterCursor,
  expenseRatios,
} from './update-data';

// ---------------------------------------------------------------------------
// Minimal ZIP (STORE) writer for test fixtures
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let value = i;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(files: Map<string, Uint8Array>): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nameBytes = encoder.encode(name);
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0, true);
    localView.setUint16(8, 0, true); // STORE
    localView.setUint32(14, crc, true);
    localView.setUint32(18, data.length, true);
    localView.setUint32(22, data.length, true);
    localView.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, data.length, true);
    centralView.setUint32(24, data.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint32(42, offset, true);
    central.set(nameBytes, 46);

    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce((sum, chunk) => sum + chunk.length, 0);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, files.size, true);
  eocdView.setUint16(10, files.size, true);
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, offset, true);
  const totalLength = offset + centralSize + 22;
  const out = new Uint8Array(totalLength);
  let position = 0;
  for (const chunk of [...locals, ...centrals, eocd]) {
    out.set(chunk, position);
    position += chunk.length;
  }
  return out;
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function sheetXml(rows: string[][]): string {
  const body = rows
    .map((row, rowIndex) => {
      const cells = row
        .map(
          (value, columnIndex) =>
            `<c r="${String.fromCharCode(65 + columnIndex)}${rowIndex + 1}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`,
        )
        .join('');
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

function buildXlsx(rows: string[][]): Uint8Array {
  const encoder = new TextEncoder();
  return buildZip(
    new Map<string, Uint8Array>([
      ['xl/workbook.xml', encoder.encode('<?xml version="1.0"?><workbook/>')],
      ['xl/worksheets/sheet1.xml', encoder.encode(sheetXml(rows))],
    ]),
  );
}

// ---------------------------------------------------------------------------
// parseRange
// ---------------------------------------------------------------------------

describe('parseRange', () => {
  test('empty and ":" mean no restriction', () => {
    expect(parseRange('', 'X')).toBeUndefined();
    expect(parseRange(':', 'X')).toBeUndefined();
    expect(parseRange('  :  ', 'X')).toBeUndefined();
  });

  test('inclusive bounds', () => {
    expect(parseRange('5:20', 'X')).toEqual({ min: 5, max: 20 });
    expect(parseRange('5:', 'X')).toEqual({ min: 5, max: undefined });
    expect(parseRange(':20', 'X')).toEqual({ min: undefined, max: 20 });
  });

  test('percent signs are optional', () => {
    expect(parseRange('1%:4.5%', 'X')).toEqual({ min: 1, max: 4.5 });
  });

  test('colonless values are rejected', () => {
    expect(() => parseRange('5', 'X')).toThrow();
    expect(() => parseRange('1:2:3', 'X')).toThrow();
  });

  test('min greater than max is rejected', () => {
    expect(() => parseRange('20:5', 'X')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// parseAumRange
// ---------------------------------------------------------------------------

describe('parseAumRange', () => {
  test('empty and ":" mean no restriction', () => {
    expect(parseAumRange('')).toBeUndefined();
    expect(parseAumRange(':')).toBeUndefined();
  });

  test('numeric bounds with K/M/B/T suffixes', () => {
    expect(parseAumRange('300M:2B')).toEqual({ source: '300M:2B', min: 300_000_000, max: 2_000_000_000, maxExclusive: false });
    expect(parseAumRange('1T:')).toBeDefined();
    // a lone lower amount must not become the upper bound as well
    expect(parseAumRange('1M:')).toEqual({ source: '1M:', min: 1_000_000 });
    expect(parseAumRange(':2B')!.min).toBeUndefined();
  });

  test('preset bounds', () => {
    const range = parseAumRange('micro:small')!;
    expect(range.min).toBe(10_000_000);
    expect(range.max).toBe(2_000_000_000);
    expect((range as any).maxExclusive).toBe(true);
    expect(parseAumRange('large:')!.min).toBe(10_000_000_000);
  });

  test('colonless values are rejected', () => {
    expect(() => parseAumRange('mid')).toThrow();
    expect(() => parseAumRange('123456789')).toThrow();
    expect(() => parseAumRange('all')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// normalizeNumberText
// ---------------------------------------------------------------------------

describe('normalizeNumberText', () => {
  test('expands scientific notation', () => {
    expect(normalizeNumberText('2.97057744E8')).toBe('297057744');
    expect(normalizeNumberText('5.84E7')).toBe('58400000');
  });

  test('keeps plain numbers and text untouched', () => {
    expect(normalizeNumberText('7.865622')).toBe('7.865622');
    expect(normalizeNumberText('NVIDIA CORP')).toBe('NVIDIA CORP');
    expect(normalizeNumberText('12/31/2030')).toBe('12/31/2030');
    expect(normalizeNumberText('-')).toBe('-');
  });
});

// ---------------------------------------------------------------------------
// XLSX parsing and sheetToTable
// ---------------------------------------------------------------------------

describe('xlsx fixtures', () => {
  test('parses equity holdings workbooks', () => {
    const rows = [
      ['Fund Name:', 'State Street SPDR S&P 500 ETF Trust'],
      ['Ticker Symbol:', 'SPY'],
      ['Holdings:', 'As of 21-Aug-2026'],
      ['Name', 'Ticker', 'Identifier', 'SEDOL', 'Weight', 'Sector', 'Shares Held', 'Local Currency'],
      ['NVIDIA CORP', 'NVDA', '67066G104', '2379504', '7.865622', '-', '2.97057744E8', 'USD'],
      ['APPLE INC', 'AAPL', '037833100', '2046251', '6.871781', '-', '1.80135563E8', 'USD'],
    ];
    const bytes = buildXlsx(rows);
    const parsed = parseXlsxSheet(bytes, loadSharedStrings(bytes));
    const { meta, table } = sheetToTable(parsed, 'holdings');
    expect(meta.fundName).toBe('State Street SPDR S&P 500 ETF Trust');
    expect(meta.ticker).toBe('SPY');
    expect(meta.asOfDate).toBe('21-Aug-2026');
    expect(table.headers).toEqual(['Name', 'Ticker', 'Identifier', 'SEDOL', 'Weight', 'Sector', 'Shares Held', 'Local Currency']);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0][0]).toBe('NVIDIA CORP');
    expect(table.rows[0][6]).toBe('297057744');
    expect(table.rows[1][1]).toBe('AAPL');
  });

  test('parses bond holdings workbooks (no Ticker column)', () => {
    const rows = [
      ['Fund Name:', 'SPDR Portfolio Aggregate Bond ETF'],
      ['Ticker Symbol:', 'SPAB'],
      ['Holdings:', 'As of 21-Aug-2026'],
      ['Name', 'Identifier', 'SEDOL', 'Weight', 'Coupon', 'Par Value', 'Market Value', 'Local Currency', 'Maturity'],
      ['US TREASURY N/B 12/28 3.5', 'US91282CPP04', 'BWH3WF4', '0.737304', '3.5', '7.7E7', '7.571265625E7', 'USD', '12/15/2028'],
    ];
    const bytes = buildXlsx(rows);
    const { table } = sheetToTable(parseXlsxSheet(bytes, loadSharedStrings(bytes)), 'holdings');
    expect(table.headers[0]).toBe('Name');
    expect(table.headers).not.toContain('Ticker');
    expect(table.rows[0][5]).toBe('77000000');
  });

  test('parses NAV history workbooks', () => {
    const rows = [
      ['Fund Name:', 'SPDR Gold MiniShares'],
      ['Ticker Symbol:', 'GLDM®'],
      ['Date', 'NAV', 'Shares Outstanding', 'Total Net Assets'],
      ['21-Aug-2026', '765.579524', '1.071332116E9', '8.2018993105119E11'],
      ['20-Aug-2026', '762.237019', '1.072982116E9', '8.1786669002065E11'],
    ];
    const bytes = buildXlsx(rows);
    const parsed = parseXlsxSheet(bytes, loadSharedStrings(bytes));
    const { meta, table } = sheetToTable(parsed, 'history');
    expect(meta.ticker).toBe('GLDM');
    expect(table.headers).toEqual(['Date', 'NAV', 'Shares Outstanding', 'Total Net Assets']);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0][1]).toBe('765.579524');
    expect(table.rows[0][2]).toBe('1071332116');
  });

  test('shared strings are resolved', () => {
    // Reuse the equity fixture but exercise sharedStrings path indirectly:
    // loadSharedStrings returns [] when the part is absent, and values are inline.
    const bytes = buildXlsx([['A1', 'B1'], ['A2', 'B2']]);
    expect(loadSharedStrings(bytes)).toEqual([]);
    expect(parseXlsxSheet(bytes, [])[0]).toEqual(['A1', 'B1']);
  });

  test('parses daily Premium/Discount history workbooks (pdhist-us-en-{ticker}.xlsx)', () => {
    const rows = [
      ['Fund Name:', 'State Street SPDR S&P 500 ETF Trust'],
      ['Ticker Symbol:', 'SPY'],
      ['Date', 'Premium/Discount'],
      ['23-Sep-2026', '0.021463'],
      ['22-Sep-2026', '-0.004259'],
      ['', ''],
    ];
    const bytes = buildXlsx(rows);
    const { meta, table } = sheetToTable(parseXlsxSheet(bytes, loadSharedStrings(bytes)), 'premium-discount');
    expect(meta.fundName).toBe('State Street SPDR S&P 500 ETF Trust');
    expect(meta.ticker).toBe('SPY');
    expect(table.headers).toEqual(['Date', 'Premium/Discount']);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0]).toEqual(['23-Sep-2026', '0.021463']);
    expect(table.rows[1]).toEqual(['22-Sep-2026', '-0.004259']);
  });
});

// ---------------------------------------------------------------------------
// parseProductDataSheet (bulk spdr-product-data-us-en.xlsx)
// ---------------------------------------------------------------------------

describe('parseProductDataSheet', () => {
  test('parses ISIN/CUSIP/SEC yield/dividend yield, skipping the disclaimer and merged period-label rows', () => {
    const rows = [
      ['Past performance is not a reliable indicator of future performance.'],
      [
        'Ticker', 'ISIN', 'CUSIP', 'Gross Expense Ratio', '* Net Expense Ratio',
        '30 Day SEC Yield', '30 Day SEC Yield (Unsubsidized)', 'Fund Dividend Yield', 'Index Dividend Yield',
        'Total Returns (Cumulative)', '', 'Total Returns (Annualized)', '',
      ],
      ['', '', '', '', '', '', '', '', '', '1 Month', 'QTD', '1 Year', '3 Year'],
      ['SPY', 'US78462F1030', '78462F103', '0.0945%', '-', '0.95%', '-', '0.99%', '1.09%', '2.71%', '2.64%', '20.21%', '20.89%'],
      ['XLK', 'US81369Y8030', '81369Y803', '0.08%', '-', '-', '-', '0.55%', '0.60%', '5.00%', '6.00%', '30.00%', '25.00%'],
      ['', '', '', '', '', '', '', '', '', '', '', '', ''],
    ];
    const bytes = buildXlsx(rows);
    const map = parseProductDataSheet(bytes);
    expect(map.size).toBe(2);

    const spy = map.get('SPY')!;
    expect(spy.isin).toBe('US78462F1030');
    expect(spy.cusip).toBe('78462F103');
    expect(spy.netExpenseRatio).toEqual({ display: null, value: null }); // "-" -> not waived
    expect(spy.secYield).toEqual({ display: '0.95%', value: 0.95 });
    expect(spy.secYieldUnsubsidized).toEqual({ display: null, value: null });
    expect(spy.fundDividendYield).toEqual({ display: '0.99%', value: 0.99 });
    expect(spy.indexDividendYield).toEqual({ display: '1.09%', value: 1.09 });

    const xlk = map.get('XLK')!;
    expect(xlk.secYield).toEqual({ display: null, value: null }); // blank/"-" SEC yield for this fund
    expect(xlk.fundDividendYield).toEqual({ display: '0.55%', value: 0.55 });
  });

  test('ignores blank trailing rows and rows missing a ticker; tolerates a missing column', () => {
    const rows = [
      ['disclaimer'],
      ['Ticker', 'ISIN', 'CUSIP'],
      ['GLDM', 'US98149E3036', '98149E303'],
      ['', '', ''],
    ];
    const bytes = buildXlsx(rows);
    const map = parseProductDataSheet(bytes);
    expect(map.size).toBe(1);
    const gldm = map.get('GLDM')!;
    expect(gldm.isin).toBe('US98149E3036');
    expect(gldm.cusip).toBe('98149E303');
    expect(gldm.secYield).toEqual({ display: null, value: null }); // column absent from this fixture
  });

  test('throws when the header row cannot be found', () => {
    const bytes = buildXlsx([['not', 'a', 'header', 'row']]);
    expect(() => parseProductDataSheet(bytes)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Catalog metric derivations (Amplify/iShares column parity)
// ---------------------------------------------------------------------------

describe('catalog metric derivations', () => {
  test('annualizedToTotal inverts annualization exactly', () => {
    // (1 + 0.1918)^3 - 1 = 0.6928...
    expect(annualizedToTotal(19.18, 3)).toBeCloseTo(69.28, 2);
    expect(annualizedToTotal(12.72, 5)).toBeCloseTo(81.97, 2);
    expect(annualizedToTotal(14.93, 10)).toBeCloseTo(302.1, 1);
  });

  test('annualizedToTotal guards bad input', () => {
    expect(annualizedToTotal(null, 3)).toBeNull();
    expect(annualizedToTotal(Number.NaN, 3)).toBeNull();
    expect(annualizedToTotal(10, 0)).toBeNull();
    expect(annualizedToTotal(-100, 5)).toBe(-100); // total-loss floor
  });

  test('indicatedYield computes latest distribution x frequency / NAV', () => {
    // SPY: quarterly $1.903516 on $765.58 NAV -> ~0.9945%
    expect(indicatedYield({ frequency: 'Quarterly', dividend: '1.903516' }, 765.58)).toBeCloseTo(0.9945, 3);
    expect(indicatedYield({ frequency: 'Monthly', dividend: '0.10' }, 25)).toBeCloseTo(4.8, 3);
    expect(indicatedYield({ frequency: 'Semi-Annually', dividend: '1.00' }, 100)).toBeCloseTo(2, 5);
    expect(indicatedYield({ frequency: 'Annually', dividend: '2.00' }, 100)).toBeCloseTo(2, 5);
  });

  test('indicatedYield guards missing pieces', () => {
    expect(indicatedYield(null, 100)).toBeNull();
    expect(indicatedYield({ frequency: 'Quarterly' }, 100)).toBeNull();
    expect(indicatedYield({ frequency: 'Quarterly', dividend: 'n/a' }, 100)).toBeNull();
    expect(indicatedYield({ frequency: 'Quarterly', dividend: '1.00' }, null)).toBeNull();
    expect(indicatedYield({ frequency: 'Weekly', dividend: '1.00' }, 100)).toBeNull();
  });

  test('deriveCatalogMetrics maps CAGRs directly and derives TRs', () => {
    const monthEnd = { ytd: 10.06, yr1: 19.4, yr3: 19.18, yr5: 12.72, yr10: 14.93, sinceInception: 10.8 };
    const metrics = deriveCatalogMetrics(monthEnd, 765.58, { frequency: 'Quarterly', exDate: '06/18/2026', dividend: '1.903516' });
    expect(metrics.cagr3y).toBe(19.18);
    expect(metrics.cagr5y).toBe(12.72);
    expect(metrics.cagr10y).toBe(14.93);
    expect(metrics.siAnn).toBe(10.8);
    expect(metrics.tr3y).toBeCloseTo(69.28, 2);
    expect(metrics.tr10y).toBeCloseTo(302.1, 1);
    expect(metrics.dividendYield).toBeCloseTo(0.9945, 3);
    expect(metrics.tr3yText).toBe('69.28%');
    expect(metrics.secYield).toBeNull();
    expect(metrics.secYieldText).toBeNull();
  });

  test('toIsoDate normalizes SSGA dates and rejects garbage', () => {
    expect(toIsoDate('Aug 31 2026')).toBe('2026-08-31');
    expect(toIsoDate('08/31/2026')).toBe('2026-08-31');
    expect(toIsoDate('2026-08-31')).toBe('2026-08-31');
    expect(toIsoDate('Feb 30 2026')).toBeNull();
    expect(toIsoDate('')).toBeNull();
    expect(toIsoDate(null)).toBeNull();
    expect(toIsoDate('-')).toBeNull();
  });

  test('deriveCatalogMetrics ends with returnsBasis and performanceAsOf (month-end date, not NAV date)', () => {
    const metrics = deriveCatalogMetrics({ asOfDate: 'Aug 31 2026', ytd: 9.29, yr1: 17.71 }, 29.06, null);
    const keys = Object.keys(metrics);
    expect(keys.slice(-2)).toEqual(['returnsBasis', 'performanceAsOf']);
    expect(metrics.ytd).toBe(9.29);
    expect(metrics.returnsBasis).toBe(RETURNS_BASIS);
    expect(String(metrics.returnsBasis).trim()).not.toBe('');
    expect(metrics.returnsBasis).not.toBe('-');
    expect(metrics.performanceAsOf).toBe('2026-08-31');
    const young = deriveCatalogMetrics({ asOfDate: null, ytd: null }, 20, null);
    expect(young.performanceAsOf).toBeNull();
    expect(young.ytd).toBeNull();
    expect(young.returnsBasis).toBe(RETURNS_BASIS);
  });

  test('deriveCatalogMetrics tolerates young funds and commodity trusts', () => {
    const metrics = deriveCatalogMetrics({ ytd: 5, yr1: 17.22, sinceInception: 15.08 }, 20.5, null);
    expect(metrics.tr3y).toBeNull();
    expect(metrics.tr3yText).toBeNull();
    expect(metrics.cagr10y).toBeNull();
    expect(metrics.dividendYield).toBeNull();
    expect(metrics.dividendYieldSource).toBeNull();
    expect(metrics.tr1y).toBe(17.22);
  });

  test('deriveCatalogMetrics prefers the official SEC yield and Fund Dividend Yield from the bulk product-data file', () => {
    const monthEnd = { ytd: 10.06, yr1: 19.4, yr3: 19.18, yr5: 12.72, yr10: 14.93, sinceInception: 10.8 };
    const productData = {
      isin: 'US78462F1030',
      cusip: '78462F103',
      netExpenseRatio: { display: null, value: null },
      secYield: { display: '0.95%', value: 0.95 },
      secYieldUnsubsidized: { display: null, value: null },
      fundDividendYield: { display: '0.99%', value: 0.99 },
      indexDividendYield: { display: '1.09%', value: 1.09 },
    };
    const metrics = deriveCatalogMetrics(monthEnd, 765.58, { frequency: 'Quarterly', dividend: '1.903516' }, productData);
    expect(metrics.secYield).toBe(0.95);
    expect(metrics.secYieldText).toBe('0.95%');
    expect(metrics.secYieldUnsubsidized).toBeNull();
    expect(metrics.secYieldUnsubsidizedText).toBeNull();
    // Official Fund Dividend Yield (0.99%) wins over the indicated ~0.9945% figure.
    expect(metrics.dividendYield).toBe(0.99);
    expect(metrics.dividendYieldText).toBe('0.99%');
    expect(metrics.dividendYieldSource).toBe('official');
    expect(metrics.indicatedDividendYield).toBeCloseTo(0.9945, 3);
  });

  test('deriveCatalogMetrics falls back to the indicated yield when a fund is missing from the bulk file', () => {
    const metrics = deriveCatalogMetrics(
      { ytd: 5, yr1: 17.22, sinceInception: 15.08 },
      25,
      { frequency: 'Monthly', dividend: '0.10' },
      undefined,
    );
    expect(metrics.secYield).toBeNull();
    expect(metrics.secYieldText).toBeNull();
    expect(metrics.dividendYieldSource).toBe('indicated');
    expect(metrics.dividendYield).toBeCloseTo(4.8, 3);
    expect(metrics.dividendYieldText).toBe('4.80%');
  });
});


import { test as frequencyLabelTest, expect as frequencyLabelExpect } from 'bun:test';
frequencyLabelTest('Frequency placeholders display None and existing cadence labels stay unchanged', async () => {
  const text = await Bun.file(new URL('../app.tsx', import.meta.url)).text();
  const start = /^([ \t]*)function (formatDividendFrequency|formatDistributionFrequency)\(/m.exec(text);
  frequencyLabelExpect(start).not.toBeNull();
  const tail = text.slice(start!.index);
  const end = new RegExp('^' + start![1] + '\u007d', 'm').exec(tail);
  frequencyLabelExpect(end).not.toBeNull();
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(tail.slice(0, end!.index + end![0].length));
  const format = new Function(js + '; return ' + start![2] + ';')();
  for (const value of [null, undefined, '', '  ', '-', '‐', '‑', '‒', '–', '—', ' — ']) {
    frequencyLabelExpect(format(value)).toBe('00 - None');
  }
  for (const [input, expected] of [
    ['None', '00 - None'], ['Unknown', '00 - Unknown'], ['Monthly', '01 - Monthly'],
    ['Quarterly', '04 - Quarterly'], ['Semi-annually', '06 - Semi-annually'],
    ['Annually', '12 - Annually'], ['Irregular', '99 - Irregular'],
  ]) frequencyLabelExpect(format(input)).toBe(expected);
});


import { test as headerTest, expect as headerExpect } from 'bun:test';
async function headerSummaryHarness() {
  const source = await Bun.file(new URL('../app.tsx', import.meta.url)).text();
  const match = /^([ \t]*)function renderHeaderSummary\(/m.exec(source);
  headerExpect(match).not.toBeNull();
  const tail = source.slice(match!.index);
  const end = new RegExp('^' + match![1] + '}', 'm').exec(tail)!;
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(tail.slice(0, end.index + end[0].length));
  const makeNode = (text = ''): any => {
    const node: any = { textContent: text, childNodes: [], dataset: {}, listeners: {} };
    node.replaceChildren = (...children: any[]) => { node.childNodes = children; };
    node.append = (...children: any[]) => { node.childNodes.push(...children); };
    node.addEventListener = (name: string, listener: any) => { node.listeners[name] = listener; };
    return node;
  };
  const panel = makeNode(), subtitle = makeNode(), details = makeNode('Data: source link and updated timestamp');
  subtitle.append(details);
  const document = { getElementById: () => panel, createTextNode: makeNode, createElement: () => makeNode() };
  const render = new Function('document', js + '; return renderHeaderSummary;')(document);
  const text = () => subtitle.childNodes.map((n: any) => n.textContent).join('');
  return { render, panel, subtitle, details, makeNode, text };
}
headerTest('header has no visible subtitle without selection; original details nodes are retained', async () => {
  const h = await headerSummaryHarness();
  h.render(h.subtitle, new Set(), null, () => {});
  headerExpect(h.text()).toBe('');
  headerExpect(h.panel.childNodes).toEqual([h.details]);
  headerExpect(h.panel.childNodes[0]).toBe(h.details);
});
headerTest('header shows sorted selected tickers only, preserving click activation and highlight', async () => {
  const h = await headerSummaryHarness(); const activated: string[] = [];
  h.render(h.subtitle, new Set(['ZZZ', 'AAA']), 'AAA', (ticker: string) => activated.push(ticker));
  headerExpect(h.text()).toBe('2 selected: AAA, ZZZ');
  const links = h.subtitle.childNodes.filter((n: any) => n.dataset.headerFund);
  headerExpect(links[0].className).toContain('underline');
  links[1].listeners.click({ preventDefault() {} });
  headerExpect(activated).toEqual(['ZZZ']);
  headerExpect(h.panel.childNodes[0]).toBe(h.details);
});
headerTest('all selected still lists tickers; clear replaces both summary and selection', async () => {
  const h = await headerSummaryHarness();
  h.render(h.subtitle, new Set(['CCC','AAA','BBB']), 'BBB', () => {});
  headerExpect(h.text()).toBe('3 selected: AAA, BBB, CCC');
  const next = h.makeNode('Fresh detail context'); h.subtitle.replaceChildren(next);
  h.render(h.subtitle, new Set(), null, () => {});
  headerExpect(h.text()).toBe(''); headerExpect(h.panel.childNodes).toEqual([next]);
});
headerTest('header markup supplies a focusable counter and hidden rich panel with dismissal', async () => {
  const html = await Bun.file(new URL('../index.html', import.meta.url)).text();
  headerExpect(html).toMatch(/<button[^>]*aria-controls="app-summary"[^>]*id="ticker-count"/);
  headerExpect(html).toContain('id="app-summary" role="region" aria-label="ETF catalog information" hidden');
  headerExpect(html).toContain("event.key !== 'Escape'");
  headerExpect(html).toContain("trigger.addEventListener('focus', show)");
  headerExpect(html).toContain("trigger.addEventListener('pointerenter'");
});

// ---------------------------------------------------------------------------
// Controls, config file, README and workflow
// ---------------------------------------------------------------------------

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const configFile = () => JSON.parse(read('scripts/update-data.config.json'));

test('configuration precedence: file < advanced < nonblank input < environment', () => {
  const c = resolveControls({ CONCURRENCY: 2, TICKERS: 'SPY' }, { CONCURRENCY: 3, TICKERS: 'XLK' }, { CONCURRENCY: '4', TICKERS: '' }, { CONCURRENCY: '6' });
  expect(c.CONCURRENCY).toBe('6'); expect(c.TICKERS).toBe('XLK');
  expect(resolveControls({ CONCURRENCY: 2 }, { CONCURRENCY: 3 }, { CONCURRENCY: '4' }).CONCURRENCY).toBe('4');
  expect(resolveControls({ TICKERS: 'SPY' }, { TICKERS: '' }, { TICKERS: '' }).TICKERS).toBe('');
  expect(resolveControls({ CONCURRENCY: 2 }, {}, { CONCURRENCY: '' }).CONCURRENCY).toBe('2');
  expect(resolveControls({ VERBOSE: true }, {}, {}, { VERBOSE: 'false' }).VERBOSE).toBe('false');
  expect(resolveControls({ MAX_RETRIES: 2 }, { MAX_RETRIES: 3 }, {}, { MAX_RETRIES: '' }).MAX_RETRIES).toBe('');
  expect(resolveControls({ REQUEST_SLEEP: 1 }, {}, {}, { SPDR_REQUEST_SLEEP: '3' }).REQUEST_SLEEP).toBe('3');
  expect(resolveControls({ REQUEST_SLEEP: 1 }, {}, {}, { REQUEST_SLEEP: '2', SPDR_REQUEST_SLEEP: '3' }).REQUEST_SLEEP).toBe('2');
});

test('scheduled path (no inputs, no advanced, no env) equals the config defaults', () => {
  const file = configFile();
  const controls = resolveControls(file, JSON.parse('{}'), {}, {});
  expect(controls).toEqual(file);
  const config = loadConfig(controls);
  expect(config.tickers).toEqual([]); expect(config.maxFetches).toBe(0); expect(config.requestSleep).toBe(1);
  expect(config.concurrency).toBe(2); expect(config.holdingsPageSize).toBe(250); expect(config.historyPageSize).toBe(1000);
  expect(config.maxRetries).toBe(2); expect(config.storeRawDownloads).toBe(false);
  expect(config.historyRange).toBe('max'); expect(config.dividendYieldRange).toBeUndefined(); expect(config.secYieldRange).toBeUndefined();
  expect(config.aumRange).toBeUndefined(); expect(config.terRange).toBeUndefined();
  expect(config.performanceRanges).toEqual({}); expect(config.totalReturnRanges).toEqual({});
});

test('runtimeControls reads the checked-in file and lets env override', async () => {
  expect(await runtimeControls({})).toEqual(configFile());
  expect((await runtimeControls({ TICKERS: 'SPY XLK', MAX_FETCHES: '5' })).MAX_FETCHES).toBe('5');
});

test('resolver rejects unknown, non-scalar, invalid and newline values', () => {
  for (const value of [{ UNKNOWN: 1 }, { OUTPUT_DIR: 'x' }, { TICKERS: 'SPY\nEVIL=yes' }, { CONCURRENCY: 0 }, { MAX_RETRIES: 0 }, { MAX_RETRIES: -1 }, { HISTORY_RANGE: '0y' }, { HISTORY_RANGE: 'forever' }, { DIVIDEND_YIELD: '3' }, { SEC_YIELD: '5:1' }, { MAX_FETCHES: 1.5 }, { REQUEST_SLEEP: '-1' },
    { VERBOSE: 'maybe' }, { STORE_RAW_DOWNLOADS: 'maybe' }, { AUM: '1:2:3' }, { TER: '5' }, { PERFORMANCE_1Y: '9:1' }, { TICKERS: ['SPY'] }, { TICKERS: { a: 1 } }, null, []]) {
    expect(() => resolveControls(value)).toThrow();
  }
  expect(() => resolveControls({}, { TICKERS: 'x\rfoo' })).toThrow();
  expect(() => resolveControls({}, {}, {}, { TICKERS: 'x\0bad' })).toThrow();
  expect(() => JSON.parse('{bad')).toThrow();
});

test('config keys, CONTROL_NAMES, README rows and --help are in sync', () => {
  const file = configFile();
  expect(Object.keys(file).sort()).toEqual([...CONTROL_NAMES].sort());
  for (const value of Object.values(file)) expect(typeof value).toBe('string');
  const doc = read('README.md');
  // README lists the five tenors of PERFORMANCE_* / TOTAL_RETURN_* on one row: `PREFIX_YTD` / `_1Y` / ...
  for (const name of CONTROL_NAMES) {
    const tenor = name.match(/^(PERFORMANCE|TOTAL_RETURN)_(1Y|3Y|5Y|10Y)$/);
    expect(doc).toContain(tenor ? '`_' + tenor[2] + '`' : '`' + name + '`');
    if (tenor) expect(doc).toContain('`' + tenor[1] + '_YTD`');
  }
  const rows = [...doc.slice(doc.indexOf('### Update controls'), doc.indexOf('### Examples')).matchAll(/^\| `([A-Z_0-9]+)`/gm)].map((m) => m[1]);
  expect(rows.filter((r) => !/^(PERFORMANCE|TOTAL_RETURN)_YTD$/.test(r))).toEqual(expect.arrayContaining(CONTROL_NAMES.filter((n) => !/^(PERFORMANCE|TOTAL_RETURN)_/.test(n))));
  expect(rows.every((r) => (CONTROL_NAMES as readonly string[]).includes(r))).toBe(true);
  expect(doc).toContain('scripts/update-data.config.json');
  const source = read('scripts/update-data.ts');
  const help = source.slice(source.indexOf('function printHelp'), source.indexOf('// HTTP with polite pacing'));
  for (const name of CONTROL_NAMES) expect(help).toContain(name);
});

test('update workflow: <= 25 inputs, advanced JSON, fixed api/spdr output, no direct input interpolation', () => {
  const yml = read('.github/workflows/update-data.yml');
  const names = [...yml.slice(yml.indexOf('    inputs:'), yml.indexOf('\npermissions:')).matchAll(/^      (\w+):$/gm)].map((m) => m[1]);
  expect(names.length).toBeLessThanOrEqual(25); expect(names).toContain('advanced');
  expect(yml).toMatch(/advanced:[\s\S]*?default: '\{\}'/);
  for (const name of names.filter((n) => n !== 'advanced')) expect(CONTROL_NAMES).toContain(name.toUpperCase() as never);
  // nothing the old workflow exposed may be dropped from the individual inputs
  for (const old of ['max_fetches', 'request_sleep', 'aum', 'ter', 'concurrency', 'holdings_page_size', 'history_page_size', 'store_raw_downloads', 'max_retries', 'tickers',
    'performance_ytd', 'performance_1y', 'performance_3y', 'performance_5y', 'performance_10y', 'total_return_ytd', 'total_return_1y', 'total_return_3y', 'total_return_5y', 'total_return_10y']) {
    expect(names).toContain(old);
  }
  expect(yml).toContain("cron: '0 0 * * 0'"); expect(yml).not.toMatch(/^  push:/m);
  expect(yml).toContain('toJSON(inputs)'); expect(yml).not.toMatch(/\$\{\{\s*inputs\./);
  expect(yml).toContain('resolveControls');
  expect(yml).toContain('git add api/spdr'); expect(yml).not.toMatch(/git add (?!api\/spdr)/);
  expect(yml).not.toContain('OUTPUT_DIR'); expect(CONTROL_NAMES as readonly string[]).not.toContain('OUTPUT_DIR');
  expect(yml).not.toContain('bunx tsc');
});

test('README keeps the standard section order and no internal artifacts', () => {
  const doc = `\n${read('README.md')}`;
  const order = ['# SPDR', '## Using Bun', '## Updating the static SPDR data', '### Data sources', '### Metrics and caveats', '### Update controls', '### Examples',
    '## TypeScript and verification', '## Brands table', '## Sibling applications', '## License'];
  let at = -1;
  for (const heading of order) { const next = doc.indexOf(`\n${heading}\n`); expect(next).toBeGreaterThan(at); at = next; }
  expect(doc).not.toMatch(/worklog|\.prompt|evidence|fixtures|config-docs/i);
});

test('workflow never writes outside api/spdr and exposes the common controls', () => {
  const yml = read('.github/workflows/update-data.yml');
  expect(yml).toContain('timeout-minutes: 30'); expect(yml).toContain('persist-credentials: false');
  for (const input of ['dividend_yield', 'sec_yield', 'history_range', 'max_retries']) expect(yml).toContain(`      ${input}:`);
});

describe('HISTORY_RANGE and yield controls', () => {
  const table = {
    headers: ['Date', 'NAV'],
    rows: [['24-Sep-2026', '3'], ['24-Mar-2026', '2'], ['23-Sep-2025', '1'], ['bad-date', '0']],
  };
  test('normalizeHistoryRange accepts max, Ny and Nmo only', () => {
    expect(normalizeHistoryRange('')).toBe('max'); expect(normalizeHistoryRange(' MAX ')).toBe('max');
    expect(normalizeHistoryRange('5Y')).toBe('5y'); expect(normalizeHistoryRange('18mo')).toBe('18mo');
    for (const bad of ['0y', '5', 'y', '-1y', '5 years']) expect(() => normalizeHistoryRange(bad)).toThrow();
  });
  test('applyHistoryRange trims rows older than the window and keeps undated rows', () => {
    expect(applyHistoryRange(table, 'max')).toBe(table);
    expect(applyHistoryRange(table, '1y').rows.map((r) => r[1])).toEqual(['3', '2', '0']);
    expect(applyHistoryRange(table, '6mo').rows.map((r) => r[1])).toEqual(['3', '2', '0']);
    expect(applyHistoryRange(table, '5mo').rows.map((r) => r[1])).toEqual(['3', '0']);
    expect(applyHistoryRange(table, '2y').rows).toHaveLength(4);
  });
  test('yield ranges parse into the config', () => {
    const config = loadConfig({ DIVIDEND_YIELD: '3:', SEC_YIELD: ':5', HISTORY_RANGE: '5y' });
    expect(config.dividendYieldRange).toEqual({ min: 3, max: undefined });
    expect(config.secYieldRange).toEqual({ min: undefined, max: 5 });
    expect(config.historyRange).toBe('5y');
  });
});

test('USE_SYSTEM_CA: auto/true/false accepted case-insensitively, others rejected, default auto', () => {
  for (const v of ['auto', 'TRUE', 'False']) expect(resolveControls({}, {}, {}, { USE_SYSTEM_CA: v }).USE_SYSTEM_CA).toBe(v);
  expect(() => resolveControls({}, {}, {}, { USE_SYSTEM_CA: 'maybe' })).toThrow('USE_SYSTEM_CA');
  expect(configFile().USE_SYSTEM_CA).toBe('auto');
});

test('isCertError matches certificate failures, also through cause', () => {
  expect(isCertError({ code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' })).toBe(true);
  expect(isCertError(new Error('unable to get local issuer certificate'))).toBe(true);
  expect(isCertError(new Error('fetch failed', { cause: new Error('self-signed certificate in certificate chain') }))).toBe(true);
  expect(isCertError({ code: 'ECONNRESET', message: 'socket hang up' })).toBe(false);
  expect(isCertError(new Error('HTTP 403 rate limited'))).toBe(false);
});

test('installSystemCa: false/active leave fetch alone, true restarts, auto wraps fetch', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  const reexec = (() => { calls++; throw new Error('reexec'); }) as () => never;
  try {
    installSystemCa('false', reexec, false);
    expect(globalThis.fetch).toBe(original);
    installSystemCa('auto', reexec, true);
    expect(globalThis.fetch).toBe(original);
    expect(() => installSystemCa('true', reexec, false)).toThrow('reexec');
    expect(calls).toBe(1);
    expect(globalThis.fetch).toBe(original);

    calls = 0;
    let mode: 'ok' | 'cert' | 'net' = 'ok';
    globalThis.fetch = (async () => {
      if (mode === 'cert') throw new Error('fetch failed', { cause: { code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' } });
      if (mode === 'net') throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      return new Response('ok');
    }) as unknown as typeof fetch;
    installSystemCa('auto', reexec, false);
    expect(await (await fetch('http://x.test')).text()).toBe('ok');
    mode = 'net';
    await expect(fetch('http://x.test')).rejects.toThrow('socket hang up');
    expect(calls).toBe(0);
    mode = 'cert';
    await expect(fetch('http://x.test')).rejects.toThrow('reexec');
    expect(calls).toBe(1);
  } finally { globalThis.fetch = original; }
});

// ---------------------------------------------------------------------------
// Pipeline with a mocked SSGA (offline): pacing, timeouts, GLD, history, writes, cursor
// ---------------------------------------------------------------------------

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dmy = (time: number) => { const d = new Date(time); return `${String(d.getUTCDate()).padStart(2, '0')}-${MON[d.getUTCMonth()]}-${d.getUTCFullYear()}`; };
const DAY = 86400000;
const NEWEST = Date.UTC(2026, 8, 30);
const historySheet = (ticker: string, rows: number) => [['Fund Name:', `${ticker} fund`], ['Ticker Symbol:', ticker], [''], ['Date', 'NAV', 'Shares Outstanding', 'Total Net Assets'],
  ...Array.from({ length: rows }, (_, i) => [dmy(NEWEST - i * 2 * DAY), String(100 + i / 10), '1', '1'])];
const pdSheet = (rows: number) => [['Date', 'Premium/Discount'], ...Array.from({ length: rows }, (_, i) => [dmy(NEWEST - i * 2 * DAY), '0.01'])];
const holdingsSheet = (ticker: string) => [['Fund Name:', `${ticker} fund`], ['Ticker Symbol:', ticker], ['As of', '30-Sep-2026'], ['Name', 'Identifier', 'Weight', 'Sector', 'Shares Held'], ['ACME', 'AC1', '50', 'Tech', '10']];
const productSheet = [['Ticker', 'ISIN', 'CUSIP', 'Gross Expense Ratio', '* Net Expense Ratio', '30 Day SEC Yield', '30 Day SEC Yield (Unsubsidized)', 'Fund Dividend Yield', 'Index Dividend Yield'],
  ['SPY', 'US1', 'C1', '0.0945%', '0.0800%', '0.95%', '-', '1.00%', '1.10%'], ['XLK', 'US2', 'C2', '0.08%', '-', '-', '-', '0.55%', '0.60%'], ['GLD', 'US3', 'C3', '0.40%', '-', '-', '-', '0.00%', '-']];

type Mock = { tickers: string[]; nav: Record<string, number>; hist: number; failNavhist: Set<string>; latency: number; inflight: number; peak: number; starts: number[] };
function fundRecord(ticker: string, nav: number, inception = 'Jan 22 1993') {
  const record: Record<string, unknown> = { fundTicker: ticker, fundName: `${ticker} ETF`, fundUri: `/etfs/${ticker.toLowerCase()}`, ter: ['0.10%', 0.1], nav: [`$${nav}`, nav], aum: ['$1,000 M', 1000], asOfDate: ['Sep 30 2026', 0], closePrice: ['$1', 1], premiumDiscount: ['0.01%', 0.01], inceptionDate: [inception, 0] };
  for (const [suffix, date] of [['', 'Aug 31 2026'], ['_1', 'Jun 30 2026']]) {
    record[`PerfAsOf${suffix}`] = [date, 0];
    for (const key of ['mo1', 'qtd', 'ytd', 'yr1', 'yr3', 'yr5', 'yr10', 'sinceInception']) record[`${key}${suffix}`] = ['5.00%', 5];
  }
  return record;
}
function installMock(overrides: Partial<Mock> = {}): { mock: Mock; restore: () => void } {
  const mock: Mock = { tickers: ['SPY', 'XLK', 'GLD'], nav: { SPY: 500, XLK: 200, GLD: 300 }, hist: 300, failNavhist: new Set(), latency: 0, inflight: 0, peak: 0, starts: [], ...overrides };
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    mock.starts.push(Date.now()); mock.inflight++; mock.peak = Math.max(mock.peak, mock.inflight);
    try {
      if (mock.latency) await new Promise((resolve) => setTimeout(resolve, mock.latency));
      const xlsx = (rows: string[][]) => new Response(buildXlsx(rows));
      if (url.includes('fundfinder')) return Response.json({ data: { funds: { etfs: { categories: [], datas: mock.tickers.map((t) => fundRecord(t, mock.nav[t])) } } } });
      if (url.includes('dividend-distribution')) return Response.json({ data: [] });
      if (url.includes('product-data')) return xlsx(productSheet);
      const match = /(holdings-daily|navhist|pdhist)-us-en-([a-z]+)\.xlsx/.exec(url);
      if (!match) return new Response('no', { status: 404 });
      const ticker = match[2].toUpperCase();
      if (match[1] === 'holdings-daily') return ticker === 'GLD' ? new Response('nf', { status: 404 }) : xlsx(holdingsSheet(ticker));
      if (match[1] === 'navhist') return mock.failNavhist.has(ticker) ? new Response('err', { status: 500 }) : xlsx(historySheet(ticker, mock.hist));
      return xlsx(pdSheet(mock.hist));
    } finally { mock.inflight--; }
  }) as unknown as typeof fetch;
  return { mock, restore: () => { globalThis.fetch = original; } };
}
const tempRoot = () => { const dir = mkdtempSync(join(tmpdir(), 'spdr-test-')); setApiRoot(pathToFileURL(`${dir}/`)); return dir; };
const readJson = (dir: string, path: string) => JSON.parse(readFileSync(join(dir, path), 'utf8'));
const listFiles = (dir: string, prefix = ''): string[] =>
  readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listFiles(dir, `${prefix}${e.name}/`) : [`${prefix}${e.name}`]));
const runMain = async (env: Record<string, string> = {}) => {
  const logs: string[] = [];
  const log = console.log; console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };
  try { await main({ REQUEST_SLEEP: '0', MAX_RETRIES: '1', USE_SYSTEM_CA: 'false', CONCURRENCY: '1', ...env }); } finally { console.log = log; }
  return logs.join('\n');
};
const origRetries = 2;

describe('pacing and timeouts', () => {
  test('paceRequests reserves the lane slot before sleeping: simultaneous callers get spaced slots (no burst)', async () => {
    configurePacing(0.15, 1);
    const t0 = Date.now();
    const starts: number[] = [];
    await Promise.all([0, 1, 2].map(async () => { await paceRequests(); starts.push(Date.now() - t0); }));
    starts.sort((a, b) => a - b);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(120);
    expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(120);
    configurePacing(1, 1, origRetries);
  });

  test('each lane paces independently: two lanes -> two immediate starts, the third waits', async () => {
    configurePacing(0.2, 2);
    const t0 = Date.now();
    const starts: number[] = [];
    await Promise.all([0, 1, 2].map(async () => { await paceRequests(); starts.push(Date.now() - t0); }));
    starts.sort((a, b) => a - b);
    expect(starts[1]).toBeLessThan(80);
    expect(starts[2]).toBeGreaterThanOrEqual(170);
    configurePacing(1, 1, origRetries);
  });

  test('in-flight counter: peak 1 at CONCURRENCY=1, peak N at CONCURRENCY=N', async () => {
    for (const [concurrency, expected] of [['1', 1], ['3', 3]] as const) {
      tempRoot();
      const { mock, restore } = installMock({ latency: 25 });
      try { await runMain({ CONCURRENCY: concurrency }); } finally { restore(); }
      expect(mock.peak).toBe(expected);
    }
  });

  test('a stalled connection (headers never arrive) is aborted by the timeout', async () => {
    const original = globalThis.fetch;
    setRequestTimeoutMs(100);
    configurePacing(0, 1, 0);
    globalThis.fetch = ((_: unknown, init?: RequestInit) => new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof fetch;
    try { await expect(fetchWithRetry('http://x.test/a', 'stall')).rejects.toThrow(); }
    finally { globalThis.fetch = original; setRequestTimeoutMs(45_000); configurePacing(1, 1, origRetries); }
  });

  test('a stalled body (headers fine, body never ends) is aborted and retried', async () => {
    const original = globalThis.fetch;
    setRequestTimeoutMs(100);
    configurePacing(0, 1, 1);
    let calls = 0;
    globalThis.fetch = ((_: unknown, init?: RequestInit) => {
      calls++;
      if (calls > 1) return Promise.resolve(new Response('ok'));
      const body = new ReadableStream({ start(controller) { init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted'))); } });
      return Promise.resolve(new Response(body));
    }) as unknown as typeof fetch;
    try {
      const response = await fetchWithRetry('http://x.test/b', 'stall-body');
      expect(await response.text()).toBe('ok');
      expect(calls).toBe(2);
    } finally { globalThis.fetch = original; setRequestTimeoutMs(45_000); configurePacing(1, 1, origRetries); }
  }, 10_000);
});

describe('pipeline (mocked SSGA)', () => {
  test('commodity trust without a holdings file (GLD) gets meta.json, empty holdings and a full metrics key set', async () => {
    const dir = tempRoot();
    const { restore } = installMock();
    try { await runMain(); } finally { restore(); }
    const index = readJson(dir, 'index.json');
    const gld = index.funds.find((f: any) => f.ticker === 'GLD');
    expect(gld.dataFile).toBe('./funds/GLD/meta.json');
    expect(existsSync(join(dir, 'funds/GLD/meta.json'))).toBe(true);
    expect(readJson(dir, 'funds/GLD/meta.json').holdings.status).toBe('empty');
    expect(gld.holdingsStatus).toBe('empty');
    expect(gld.history).toBeGreaterThan(0);
    const spy = index.funds.find((f: any) => f.ticker === 'SPY');
    expect(Object.keys(gld.metrics)).toEqual(Object.keys(spy.metrics));
    for (const row of index.funds) if (row.dataFile) expect(existsSync(join(dir, row.dataFile))).toBe(true);
  });

  test('a fund that never got a meta.json is listed with dataFile null and a full metrics object', async () => {
    const dir = tempRoot();
    const { restore } = installMock({ failNavhist: new Set(['XLK']) });
    try { await runMain(); } finally { restore(); }
    const index = readJson(dir, 'index.json');
    const xlk = index.funds.find((f: any) => f.ticker === 'XLK');
    expect(xlk.dataFile).toBeNull();
    expect(Object.keys(xlk.metrics)).toEqual(Object.keys(index.funds[0].metrics));
    expect(xlk.metrics.returnsBasis).toBe(RETURNS_BASIS);
  });

  test('HISTORY_RANGE shorter than the published history keeps the older pages and rows', async () => {
    const dir = tempRoot();
    const { restore } = installMock({ hist: 400 });
    try {
      await runMain({ HISTORY_PAGE_SIZE: '100', TICKERS: 'SPY' });
      const before = listFiles(dir, 'funds/SPY/history/');
      expect(before.length).toBe(4);
      await runMain({ HISTORY_PAGE_SIZE: '100', TICKERS: 'SPY', HISTORY_RANGE: '1y' });
    } finally { restore(); }
    expect(listFiles(dir, 'funds/SPY/history/').length).toBe(4);
    const meta = readJson(dir, 'funds/SPY/meta.json');
    expect(meta.history.totalRows).toBe(400);
    expect(meta.premiumDiscountHistory.totalRows).toBe(400);
    expect(readJson(dir, 'index.json').funds.find((f: any) => f.ticker === 'SPY').history).toBe(400);
  });

  test('mergeOlderRows carries over only rows older than the new window and keeps the order', async () => {
    const dir = tempRoot();
    const fundDir = new URL(`${pathToFileURL(dir).href}/funds/X/`);
    mkdirSync(join(dir, 'funds/X/history'), { recursive: true });
    const headers = ['Date', 'NAV'];
    writeFileSync(join(dir, 'funds/X/history/001.json'), JSON.stringify({ headers, rows: [{ Date: '05-Jan-2026', NAV: '3' }, { Date: '04-Jan-2025', NAV: '2' }, { Date: '03-Jan-2024', NAV: '1' }] }));
    const merged = await mergeOlderRows(fundDir, 'history', { headers, rows: [['05-Jan-2026', '3'], ['06-Jun-2025', '2.5']] });
    expect(merged.rows.map((r) => r[0])).toEqual(['05-Jan-2026', '06-Jun-2025', '04-Jan-2025', '03-Jan-2024']);
  });

  test('a rerun with identical upstream data writes nothing (zero diff, no temp files)', async () => {
    const dir = tempRoot();
    const { restore } = installMock();
    try {
      await runMain();
      const snapshot = Object.fromEntries(listFiles(dir).map((f) => [f, `${statSync(join(dir, f)).mtimeMs}:${readFileSync(join(dir, f), 'utf8').length}`]));
      await new Promise((resolve) => setTimeout(resolve, 25));
      await runMain();
      const after = Object.fromEntries(listFiles(dir).map((f) => [f, `${statSync(join(dir, f)).mtimeMs}:${readFileSync(join(dir, f), 'utf8').length}`]));
      expect(after).toEqual(snapshot);
      expect(listFiles(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    } finally { restore(); }
  });

  test('generatedAt moves only with content and is ISO without milliseconds', async () => {
    const dir = tempRoot();
    const first = installMock();
    try { await runMain(); } finally { first.restore(); }
    const stamp = readJson(dir, 'index.json').generatedAt;
    expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const changed = installMock({ nav: { SPY: 501, XLK: 200, GLD: 300 } });
    try { await runMain(); } finally { changed.restore(); }
    expect(readJson(dir, 'index.json').generatedAt).not.toBe(stamp);
  });

  test('fund-level consistency: a fund whose refresh failed keeps its previous index row and meta together', async () => {
    const dir = tempRoot();
    const first = installMock();
    try { await runMain(); } finally { first.restore(); }
    const second = installMock({ nav: { SPY: 777, XLK: 200, GLD: 300 }, failNavhist: new Set(['SPY']) });
    try { await runMain(); } finally { second.restore(); }
    const row = readJson(dir, 'index.json').funds.find((f: any) => f.ticker === 'SPY');
    expect(row.navValue).toBe(500);
    expect(readJson(dir, 'funds/SPY/meta.json').nav.value).toBe(500);
  });

  test('unknown TICKERS is an error and writes nothing; every selected fund failing is an error', async () => {
    const dir = tempRoot();
    const { restore } = installMock();
    try {
      await expect(runMain({ TICKERS: 'XXXX' })).rejects.toThrow(/unknown ticker/);
      expect(existsSync(join(dir, 'index.json'))).toBe(false);
    } finally { restore(); }
    const failing = installMock({ tickers: ['SPY', 'XLK', 'GLD'], failNavhist: new Set(['SPY', 'XLK', 'GLD']) });
    try { await expect(runMain({ CONCURRENCY: '3' })).rejects.toThrow(/all 3 selected funds failed/); } finally { failing.restore(); }
  }, 20_000);

  test('NEW FUNDS: tickers missing from the previous index are announced', async () => {
    tempRoot();
    const first = installMock({ tickers: ['SPY', 'XLK'] });
    try { await runMain(); } finally { first.restore(); }
    const second = installMock({ tickers: ['SPY', 'XLK', 'GLD'] });
    try { expect(await runMain()).toContain('NEW FUNDS: GLD'); } finally { second.restore(); }
  });

  test('soft deadline: no new funds are started, the index is still written', async () => {
    const dir = tempRoot();
    setSoftDeadlineMs(-1);
    const { restore } = installMock();
    try { await runMain(); } finally { restore(); setSoftDeadlineMs(25 * 60_000); }
    expect(readJson(dir, 'index.json').funds.length).toBe(3);
    expect(existsSync(join(dir, 'funds/SPY/meta.json'))).toBe(false);
  });

  test('bounded cursor: a TICKERS run does not touch update-state.json; a cursor from another filter set is ignored', async () => {
    const dir = tempRoot();
    const { restore } = installMock();
    try {
      await runMain({ MAX_FETCHES: '2' });
      expect(readJson(dir, 'update-state.json').lastProcessedTicker).toBe('SPY');
      const saved = readFileSync(join(dir, 'update-state.json'), 'utf8');
      await runMain({ MAX_FETCHES: '1', TICKERS: 'XLK' });
      expect(readFileSync(join(dir, 'update-state.json'), 'utf8')).toBe(saved);
      await runMain({ MAX_FETCHES: '1', AUM: '1M:' });
      expect(readJson(dir, 'update-state.json').lastProcessedTicker).toBe('GLD');
    } finally { restore(); }
  });

  test('rotateAfterCursor wraps around and tolerates a cursor ticker that is no longer selected', () => {
    const funds = ['A', 'C', 'E'].map((ticker) => ({ ticker }));
    expect(rotateAfterCursor(funds, 'C').map((f) => f.ticker)).toEqual(['E', 'A', 'C']);
    expect(rotateAfterCursor(funds, 'D').map((f) => f.ticker)).toEqual(['E', 'A', 'C']);
    expect(rotateAfterCursor(funds, 'E').map((f) => f.ticker)).toEqual(['A', 'C', 'E']);
    expect(rotateAfterCursor(funds, null).map((f) => f.ticker)).toEqual(['A', 'C', 'E']);
  });
});

describe('metrics, TER and strict config', () => {
  test('TER standard: terValue is the net ratio, terGrossValue the gross one', () => {
    const fund = { ter: '0.10%', terValue: 0.1 };
    const net = { grossExpenseRatio: { display: '0.18%', value: 0.18 }, netExpenseRatio: { display: '0.08%', value: 0.08 } } as any;
    expect(expenseRatios(fund, net)).toEqual({ ter: '0.08%', terValue: 0.08, terGross: '0.18%', terGrossValue: 0.18 });
    expect(expenseRatios(fund, { grossExpenseRatio: { display: '0.18%', value: 0.18 }, netExpenseRatio: { display: null, value: null } } as any)).toEqual({ ter: '0.18%', terValue: 0.18, terGross: '0.18%', terGrossValue: 0.18 });
    expect(expenseRatios(fund, null)).toEqual({ ter: '0.10%', terValue: 0.1, terGross: '0.10%', terGrossValue: 0.1 });
  });

  test('siAnn is null for funds with less than one year of history, kept otherwise', () => {
    const base = { asOfDate: 'Aug 31 2026', ytd: 1, sinceInception: 4.2 };
    expect(deriveCatalogMetrics({ ...base, inceptionDate: 'Feb 10 2026' }, 10, null).siAnn).toBeNull();
    expect(deriveCatalogMetrics({ ...base, inceptionDate: 'Aug 31 2025' }, 10, null).siAnn).toBe(4.2);
    expect(deriveCatalogMetrics({ ...base, inceptionDate: 'Sep 01 2025' }, 10, null).siAnn).toBeNull();
  });

  test('semi-annual distributions count as 2 payments per year', () => {
    expect(indicatedYield({ frequency: 'Semi-Annually', dividend: '1' }, 100)).toBe(2);
  });

  test('loadConfig has no silent fallbacks for invalid values', () => {
    for (const bad of [{ CONCURRENCY: 'abc' }, { MAX_FETCHES: 'x' }, { MAX_RETRIES: '0' }, { HOLDINGS_PAGE_SIZE: '-5' }, { HISTORY_PAGE_SIZE: '1.5' }, { REQUEST_SLEEP: 'fast' }, { STORE_RAW_DOWNLOADS: 'maybe' }]) {
      expect(() => loadConfig(bad)).toThrow();
    }
    expect(loadConfig({}).concurrency).toBe(2);
    expect(loadConfig({ STORE_RAW_DOWNLOADS: 'off' }).storeRawDownloads).toBe(false);
  });

  test('dates parse as UTC: the same output east of UTC', () => {
    const saved = process.env.TZ;
    process.env.TZ = 'Pacific/Kiritimati';
    try {
      expect(toIsoDate('Jun 04 2026')).toBe('2026-06-04');
      const table = { headers: ['Date', 'NAV'], rows: [['02-Jan-2026', '1'], ['03-Jan-2025', '2'], ['01-Jan-2024', '3']] };
      expect(applyHistoryRange(table, '1y').rows.length).toBe(2);
    } finally { if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved; }
  });
});
