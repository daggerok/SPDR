/// <reference types="bun" />
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { CONTROL_NAMES, loadConfig, resolveControls, runtimeControls } from './update-data';
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const configFile = () => JSON.parse(read('scripts/update-data.config.json'));

test('configuration precedence: file < advanced < nonblank input < environment', () => {
  const c = resolveControls({ CONCURRENCY: 2, TICKERS: 'SPY' }, { CONCURRENCY: 3, TICKERS: 'XLK' }, { CONCURRENCY: '4', TICKERS: '' }, { CONCURRENCY: '6' });
  expect(c.CONCURRENCY).toBe('6'); expect(c.TICKERS).toBe('XLK');
  expect(resolveControls({ CONCURRENCY: 2 }, { CONCURRENCY: 3 }, { CONCURRENCY: '4' }).CONCURRENCY).toBe('4');
  expect(resolveControls({ TICKERS: 'SPY' }, { TICKERS: '' }, { TICKERS: '' }).TICKERS).toBe('');
  expect(resolveControls({ CONCURRENCY: 2 }, {}, { CONCURRENCY: '' }).CONCURRENCY).toBe('2');
  expect(resolveControls({ VERBOSE: true }, {}, {}, { VERBOSE: 'false' }).VERBOSE).toBe('false');
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
  expect(config.aumRange).toBeUndefined(); expect(config.terRange).toBeUndefined();
  expect(config.performanceRanges).toEqual({}); expect(config.totalReturnRanges).toEqual({});
});

test('runtimeControls reads the checked-in file and lets env override', async () => {
  expect(await runtimeControls({})).toEqual(configFile());
  expect((await runtimeControls({ TICKERS: 'SPY XLK', MAX_FETCHES: '5' })).MAX_FETCHES).toBe('5');
});

test('resolver rejects unknown, non-scalar, invalid and newline values', () => {
  for (const value of [{ UNKNOWN: 1 }, { OUTPUT_DIR: 'x' }, { TICKERS: 'SPY\nEVIL=yes' }, { CONCURRENCY: 0 }, { MAX_RETRIES: -1 }, { MAX_FETCHES: 1.5 }, { REQUEST_SLEEP: '-1' },
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
