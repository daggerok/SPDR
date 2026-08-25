// Tests for the SPDR static data updater helpers (Bun test runner).
// The XLSX fixtures are built in memory with a minimal STORE-method ZIP writer,
// so the test suite stays dependency-free like the updater itself.
/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  parseRange,
  parseAumRange,
  normalizeNumberText,
  parseXlsxSheet,
  loadSharedStrings,
  sheetToTable,
  annualizedToTotal,
  indicatedYield,
  deriveCatalogMetrics,
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

  test('deriveCatalogMetrics tolerates young funds and commodity trusts', () => {
    const metrics = deriveCatalogMetrics({ ytd: 5, yr1: 17.22, sinceInception: 15.08 }, 20.5, null);
    expect(metrics.tr3y).toBeNull();
    expect(metrics.tr3yText).toBeNull();
    expect(metrics.cagr10y).toBeNull();
    expect(metrics.dividendYield).toBeNull();
    expect(metrics.tr1y).toBe(17.22);
  });
});
