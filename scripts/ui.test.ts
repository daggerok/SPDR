/**
 * Acceptance tests for the SPDR ETF UI contract (app.tsx).
 *
 * These boot the real application from app.tsx inside a headless harness
 * (scripts/ui-harness.ts) that serves the actual generated feed from
 * api/spdr/. Expected Watchlist values are computed independently from the
 * feed (oracle helpers in the harness) — nothing is hardcoded from other
 * providers.
 */
import { expect, test } from "bun:test";
import {
  AppHandle,
  MemoryStorage,
  catalogTickers,
  createApp,
  expectedWatchlist,
  feedJson,
  sleep,
} from "./ui-harness";

const SORTS_KEY = "spdr-tab-sorts";
const FILTERS_KEY = "spdr-tab-filters";
const SELECTED_KEY = "spdr-selected-etfs";
const ACTIVE_FUND_KEY = "spdr-active-fund";
const SITE_STATE_KEY = "spdr-site-state";

async function until(cond: () => boolean, timeoutMs = 30000, stepMs = 20) {
  await sleep(stepMs);
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for condition");
    await sleep(stepMs);
  }
}

async function bootFresh(storage?: MemoryStorage): Promise<AppHandle> {
  const app = await createApp({ storage });
  await app.boot();
  await until(() => app.api().state.funds.length > 0);
  return app;
}

function sortButton(app: AppHandle, key: string) {
  const button = app
    .el("table-head")
    .querySelectorAll("button[data-sort]")
    .find((el) => el.dataset.sort === key);
  if (!button) throw new Error(`sort header not found: ${key}`);
  return button;
}

function clickSort(app: AppHandle, key: string) {
  sortButton(app, key).click();
}

function catalogRow(app: AppHandle, ticker: string) {
  const row = app.el("table-body").querySelector(`tr[data-ticker="${ticker}"]`);
  if (!row) throw new Error(`catalog row not found: ${ticker}`);
  return row;
}

function toggleRow(app: AppHandle, ticker: string) {
  catalogRow(app, ticker).click();
}

function headerCheckbox(app: AppHandle) {
  const cb = app.el("table-head").querySelector("#select-all-checkbox");
  if (!cb) throw new Error("header select-all checkbox not found");
  return cb;
}

function pillCheckbox(app: AppHandle) {
  const cb = app.el("tabs-bar").querySelector("#select-all-toggle");
  if (!cb) throw new Error("All ETFs pill checkbox not found");
  return cb;
}

function setChecked(el: { checked: boolean; dispatch: (t: string, i?: object) => void }, checked: boolean) {
  el.checked = checked;
  el.dispatch("change", { target: el });
}

function setSearch(app: AppHandle, query: string) {
  const input = app.el("search-input");
  input.value = query;
  input.dispatch("input", { target: input });
}

async function waitForTab(app: AppHandle, tabId: string) {
  await until(() => app.api().state.activeTab === tabId, 10000);
  await sleep(40);
}

async function clickTab(app: AppHandle, tabId: string) {
  const button =
    app.el("selected-tabs-bar").querySelector(`button[data-tab="${tabId}"]`) ||
    app.el("tabs-bar").querySelector(`button[data-tab="${tabId}"]`);
  if (!button) throw new Error(`tab button not found: ${tabId}`);
  button.click();
  await waitForTab(app, tabId);
}

function selectedTickers(app: AppHandle): string[] {
  return [...app.api().state.selected].sort();
}

function watchlistTabLabel(app: AppHandle): string {
  const match = /Watchlist\s*\(([^)]*)\)/.exec(app.el("selected-tabs-bar").innerHTML);
  return match ? match[1] : "";
}

async function waitWatchlistCount(app: AppHandle, expected: number, timeoutMs = 60000) {
  await until(() => app.api().getDedupedWatchlistRows().length === expected, timeoutMs);
  await until(() => watchlistTabLabel(app).replace(/,/g, "") === String(expected), timeoutMs);
}

async function waitForHoldingsSettled(app: AppHandle, timeoutMs = 300000) {
  await until(() => !app.api().isHoldingsLoading(), timeoutMs);
  await until(() => {
    const rows = app.api().getDedupedWatchlistRows().length;
    const label = watchlistTabLabel(app).replace(/,/g, "");
    return !app.api().isHoldingsLoading() && rows > 0 && label === String(rows);
  }, Math.min(timeoutMs, 30000));
}

function visibleCatalogTickers(app: AppHandle): string[] {
  return app.api().filterRows(app.api().visibleFunds()).map((row: any) => row.ticker).sort();
}

// =============================================================================
// 1. Sort persistence round-trip
// =============================================================================

test("1. per-tab sort survives tabs, checkboxes, buttons, Clear, and reload", async () => {
  const app = await bootFresh();

  clickSort(app, "yr1"); // TR 1Y, numeric -> starts descending
  expect(app.api().state.sortKey).toBe("yr1");
  expect(app.api().state.sortDir).toBe("desc");
  expect(app.el("table-head").innerHTML).toContain("TR 1Y ↓");
  expect(JSON.parse(app.storage.getItem(SORTS_KEY)!)).toEqual({
    All: { key: "yr1", dir: "desc" },
  });

  toggleRow(app, "SPY");
  await until(() => app.el("selected-tabs-bar").innerHTML.includes("Watchlist"));
  await clickTab(app, "watchlist");
  expect(app.api().state.activeTab).toBe("watchlist");

  clickSort(app, "fundCount");
  expect(app.api().state.sortKey).toBe("fundCount");

  app.el("tabs-bar").querySelector("#all-etfs-tab-btn")!.click();
  await waitForTab(app, "All");
  expect(app.api().state.sortKey).toBe("yr1");
  expect(app.api().state.sortDir).toBe("desc");
  expect(app.el("table-head").innerHTML).toContain("TR 1Y ↓");

  setChecked(headerCheckbox(app), true);
  setChecked(pillCheckbox(app), true);
  setChecked(pillCheckbox(app), false);
  setChecked(headerCheckbox(app), false);
  expect(app.api().state.sortKey).toBe("yr1");

  setSearch(app, "bond");
  setSearch(app, "");
  app.el("copy-btn").click();
  app.el("theme-toggle").click();
  expect(app.api().state.sortKey).toBe("yr1");

  app.el("reset-btn").click();
  expect(selectedTickers(app)).toEqual([]);
  expect(app.el("search-input").value).toBe("");
  expect(app.api().state.sortKey).toBe("yr1");
  expect(app.api().state.sortDir).toBe("desc");
  expect(app.el("table-head").innerHTML).toContain("TR 1Y ↓");
  expect(JSON.parse(app.storage.getItem(SORTS_KEY)!)).toEqual({
    All: { key: "yr1", dir: "desc" },
    watchlist: { key: "fundCount", dir: "desc" },
  });

  const reloaded = await bootFresh(app.storage);
  expect(reloaded.api().state.sortKey).toBe("yr1");
  expect(reloaded.api().state.sortDir).toBe("desc");
  expect(reloaded.el("table-head").innerHTML).toContain("TR 1Y ↓");
}, 60000);

test("1b. Watchlist remembers its own sort separately from the catalog", async () => {
  const app = await bootFresh();
  toggleRow(app, "SPY");
  await until(() => app.el("selected-tabs-bar").innerHTML.includes("Watchlist"));
  await clickTab(app, "watchlist");
  expect(JSON.parse(app.storage.getItem(SORTS_KEY) || "{}").watchlist).toBeUndefined();
  clickSort(app, "symbol");
  clickSort(app, "symbol");
  expect(app.api().state.sortKey).toBe("symbol");
  expect(app.api().state.sortDir).toBe("desc");

  app.el("tabs-bar").querySelector("#all-etfs-tab-btn")!.click();
  await waitForTab(app, "All");
  expect(app.api().state.sortKey).toBe("rank");

  await clickTab(app, "watchlist");
  expect(app.api().state.sortKey).toBe("symbol");
  expect(app.api().state.sortDir).toBe("desc");
}, 60000);

// =============================================================================
// 2+3. Header select-all is scoped to the visible (filtered) rows
// =============================================================================

test("2. header Use check selects exactly the filtered ETFs", async () => {
  const app = await bootFresh();
  setSearch(app, "spy");
  const visible = visibleCatalogTickers(app);
  expect(visible.length).toBe(6);
  expect(visible).toContain("SPY");

  setChecked(headerCheckbox(app), true);
  expect(selectedTickers(app)).toEqual(visible);
}, 60000);

test("3. header Use uncheck removes only visible tickers; hidden selections survive", async () => {
  const app = await bootFresh();

  toggleRow(app, "BIL");

  setSearch(app, "spy");
  const visible = visibleCatalogTickers(app);
  expect(visible).not.toContain("BIL");

  setChecked(headerCheckbox(app), true);
  expect(selectedTickers(app)).toEqual([...visible, "BIL"].sort());
  expect(headerCheckbox(app).checked).toBe(true);

  setChecked(headerCheckbox(app), false);
  expect(selectedTickers(app)).toEqual(["BIL"]);
  expect(app.el("table-head").innerHTML.includes("Net Assets")).toBe(true);
}, 60000);

// =============================================================================
// 4. All ETFs pill checkbox: whole catalog, filter/tab independent, no nav
// =============================================================================

test("4. All ETFs pill selects the whole non-blacklisted catalog without navigating", async () => {
  const app = await bootFresh();
  const all = catalogTickers();
  app.api().blacklistTickers(["BIL"]);
  await until(() => [...app.api().state.blacklist].length === 1);

  toggleRow(app, "SPY");
  await until(() => app.el("selected-tabs-bar").innerHTML.includes("Watchlist"));
  setSearch(app, "bond");
  await clickTab(app, "watchlist");
  setChecked(pillCheckbox(app), true);

  expect(app.api().state.activeTab).toBe("watchlist");
  const selected = selectedTickers(app);
  expect(selected).not.toContain("BIL");
  expect(selected.length).toBe(all.length - 1);
  expect(selected).toEqual(all.filter((t) => t !== "BIL").sort());
  expect(pillCheckbox(app).checked).toBe(true);

  setChecked(pillCheckbox(app), false);
  expect(app.api().state.activeTab).toBe("watchlist");
  expect(selectedTickers(app)).toEqual([]);

  app.el("tabs-bar").querySelector("#all-etfs-tab-btn")!.click();
  await waitForTab(app, "All");
  setSearch(app, "");
  toggleRow(app, "CWI");
  await until(() => app.el("selected-tabs-bar").innerHTML.includes("CWI Overview") || app.el("selected-tabs-bar").innerHTML.includes("Overview"));
  await clickTab(app, "detail:holdings");
  await waitForTab(app, "detail:holdings");
  setChecked(pillCheckbox(app), true);
  expect(app.api().state.activeTab).toBe("detail:holdings");
  expect(selectedTickers(app).length).toBe(all.length - 1);
}, 120000);

// =============================================================================
// 5. Watchlist reacts to selection: Loading… then exact count
// =============================================================================

test("5. selecting one ETF shows Watchlist Loading then the exact count", async () => {
  const app = await bootFresh();
  app.stats.latency = (url) => (url.includes("/SPY/") ? 60 : 0);

  toggleRow(app, "SPY");

  await sleep(10);
  const labelDuringLoad = watchlistTabLabel(app);
  expect(labelDuringLoad).not.toBe("0");

  const expected = expectedWatchlist(["SPY"]).size;
  await until(() => watchlistTabLabel(app) === String(expected) || watchlistTabLabel(app) === expected.toLocaleString("en-US"), 60000);
  expect(app.api().getDedupedWatchlistRows().length).toBe(expected);
}, 120000);

// =============================================================================
// 6. Race-free holdings loading for overlapping rapid selections
// =============================================================================

test("6. rapid overlapping selections load without duplicate or skipped pages", async () => {
  const app = await bootFresh();
  app.stats.latency = (url) => (url.includes("/SPY/") || url.includes("/XLK/") ? 40 : 0);

  toggleRow(app, "SPY");
  toggleRow(app, "XLK");

  const oracle = expectedWatchlist(["SPY", "XLK"]);
  await waitWatchlistCount(app, oracle.size, 90000);

  const spyPages: string[] = feedJson("funds/SPY/meta.json").holdings.pages;
  const xlkPages: string[] = feedJson("funds/XLK/meta.json").holdings.pages;
  for (const page of [
    ...spyPages.map((p) => `./api/spdr/funds/SPY/${p.replace(/^\.\//, "")}`),
    ...xlkPages.map((p) => `./api/spdr/funds/XLK/${p.replace(/^\.\//, "")}`),
  ]) {
    expect(app.stats.counts.get(page) ?? 0).toBe(1);
  }
  expect(app.stats.counts.get("./api/spdr/funds/SPY/meta.json") ?? 0).toBe(1);
  expect(app.stats.counts.get("./api/spdr/funds/XLK/meta.json") ?? 0).toBe(1);

  const overlap = [...oracle.values()].find((row) => row.funds.size === 2 && row.hasWeight);
  expect(overlap).toBeDefined();
  const appRow = app.api().getDedupedWatchlistRows().find((row: any) => row.symbol === overlap!.shown);
  expect(appRow).toBeDefined();
  expect(appRow.fundCount).toBe(2);
  expect(Number(appRow.weightSum)).toBeCloseTo(overlap!.weightSum, 1);
  expect(Number(appRow.maxWeight)).toBeCloseTo(overlap!.maxWeight, 1);
}, 180000);

// =============================================================================
// 7. Deselection updates everything immediately
// =============================================================================

test("7. deselecting an ETF updates subtitle, tabs and Watchlist immediately", async () => {
  const app = await bootFresh();
  toggleRow(app, "SPY");
  toggleRow(app, "XLK");
  const both = expectedWatchlist(["SPY", "XLK"]).size;
  await waitWatchlistCount(app, both, 90000);
  expect(watchlistTabLabel(app).replace(/,/g, "")).toBe(String(both));

  toggleRow(app, "XLK");

  const onlySpy = expectedWatchlist(["SPY"]).size;
  expect(app.api().getDedupedWatchlistRows().length).toBe(onlySpy);
  expect(watchlistTabLabel(app).replace(/,/g, "")).toBe(String(onlySpy));
  expect(app.el("app-subtitle").innerHTML).toContain("1 selected");
  expect(app.el("app-subtitle").innerHTML).not.toContain(">XLK<");
  expect(app.el("selected-tabs-bar").innerHTML).toContain("SPY Overview");
  expect(app.api().state.activeFundTicker).toBe("SPY");
}, 180000);

// =============================================================================
// 8. Select-all loads the complete catalog aggregate; DOM stays bounded
// =============================================================================

test("8. selecting all ETFs aggregates the whole feed and keeps the DOM bounded", async () => {
  const app = await bootFresh();
  const all = catalogTickers();
  setChecked(pillCheckbox(app), true);
  expect(selectedTickers(app).length).toBe(all.length);

  const oracle = expectedWatchlist(all);
  await waitForHoldingsSettled(app, 600000);
  expect(app.api().getDedupedWatchlistRows().length).toBe(oracle.size);
  expect(watchlistTabLabel(app).replace(/,/g, "")).toBe(String(oracle.size));

  await clickTab(app, "watchlist");
  await until(() => app.api().state.activeTab === "watchlist");
  const renderedRows = (app.el("table-body").innerHTML.match(/<tr\b/g) ?? []).length;
  expect(renderedRows).toBeGreaterThan(0);
  expect(renderedRows).toBeLessThanOrEqual(400);
  expect(oracle.size).toBeGreaterThan(1000);

  const scroll = app.el("table-scroll");
  scroll.scrollTop = scroll.scrollHeight - scroll.clientHeight - 100;
  scroll.dispatch("scroll", { target: scroll });
  const grownRows = (app.el("table-body").innerHTML.match(/<tr\b/g) ?? []).length;
  expect(grownRows).toBeGreaterThan(renderedRows);
  expect(grownRows).toBeLessThanOrEqual(800);

  const copyCount = app.api().getDedupedWatchlistRows().length;
  expect(copyCount).toBe(oracle.size);
}, 600000);

// =============================================================================
// 9. Reload restores selection, active fund, and background loading
// =============================================================================

test("9. reload restores selection, active fund and rebuilds the Watchlist", async () => {
  const app = await bootFresh();
  toggleRow(app, "SPY");
  toggleRow(app, "XLK");
  const both = expectedWatchlist(["SPY", "XLK"]).size;
  await waitWatchlistCount(app, both, 90000);
  expect(app.api().state.activeFundTicker).toBe("XLK");

  const reloaded = await bootFresh(app.storage);
  expect(selectedTickers(reloaded)).toEqual(["SPY", "XLK"]);
  expect(reloaded.api().state.activeFundTicker).toBe("XLK");

  await waitWatchlistCount(reloaded, both, 90000);
  expect(watchlistTabLabel(reloaded).replace(/,/g, "")).toBe(String(both));
  expect(reloaded.el("selected-tabs-bar").innerHTML).toContain("XLK Overview");
}, 300000);

// =============================================================================
// 10. Detail sheets render real rows and page onward
// =============================================================================

test("10. Overview, Holdings, History and Distributions render real rows", async () => {
  const app = await bootFresh();
  toggleRow(app, "SPY");
  await until(() => app.el("selected-tabs-bar").innerHTML.includes("SPY Overview"));

  await clickTab(app, "detail:holdings");
  await waitForTab(app, "detail:holdings");
  const firstPageRow = feedJson("funds/SPY/holdings/001.json").rows[0];
  await until(() => app.el("table-body").innerHTML.includes(String(firstPageRow.Ticker)));

  const scroll = app.el("table-scroll");
  scroll.scrollHeight = 20000;
  scroll.scrollTop = 20000 - scroll.clientHeight - 100;
  scroll.dispatch("scroll", { target: scroll });
  const secondPageRow = feedJson("funds/SPY/holdings/002.json").rows[0];
  await until(() => {
    const body = app.el("table-body").innerHTML;
    const entry = app.api().sheetState.get("SPY:holdings");
    return body.includes(String(secondPageRow.Ticker)) || Boolean(entry && entry.nextPage >= 2);
  }, 30000);
  expect(app.el("table-body").innerHTML.includes(String(firstPageRow.Ticker)) || app.api().sheetState.get("SPY:holdings").rows.length > 0).toBe(true);

  await clickTab(app, "detail:history");
  await until(() => app.api().state.activeTab === "detail:history");
  await until(() => app.el("table-body").innerHTML.includes("<tr"));
  const historyRow = feedJson("funds/SPY/history/001.json").rows[0];
  await until(() => app.el("table-body").innerHTML.includes(historyRow.Date), 30000);

  await clickTab(app, "detail:overview");
  await until(() => app.api().state.activeTab === "detail:overview");
  await until(() => app.el("table-body").innerHTML.includes("YTD") || app.el("table-body").innerHTML.includes("TR 1Y") || app.el("table-head").innerHTML.includes("Metric"));

  await clickTab(app, "detail:distributions");
  await until(() => app.api().state.activeTab === "detail:distributions");
  const distributions = feedJson("funds/SPY/meta.json").distributions;
  const latestExDate = distributions.rows[0][1];
  await until(() => app.el("table-body").innerHTML.includes(latestExDate));
  expect(app.el("table-head").innerHTML).toContain("Ex-Date");
  expect(app.el("table-body").innerHTML).toContain(latestExDate);
}, 120000);

// =============================================================================
// 11. Missing/failing fund data produces an explanatory state
// =============================================================================

test("11. a fund whose files fail to load shows an explanatory empty state", async () => {
  const app = await bootFresh();
  toggleRow(app, "SPY");
  await until(() => app.el("selected-tabs-bar").innerHTML.includes("SPY Overview"));
  await clickTab(app, "detail:holdings");
  await until(() => app.el("table-body").innerHTML.length > 100);
  expect(app.el("table-body").innerHTML.toLowerCase()).not.toContain("could not load");

  app.el("tabs-bar").querySelector("#all-etfs-tab-btn")!.click();
  await waitForTab(app, "All");

  const priorTicker = String(feedJson("funds/SPY/holdings/001.json").rows[0].Ticker);
  app.stats.blocked.add("funds/CWI/");
  toggleRow(app, "CWI");
  toggleRow(app, "SPY");
  await until(() => app.api().state.activeFundTicker === "CWI");
  await clickTab(app, "detail:holdings");
  await until(() => app.el("table-body").innerHTML.toLowerCase().includes("could not load"), 10000);
  const body = app.el("table-body").innerHTML;
  expect(body).not.toContain(priorTicker);
  expect(body.toLowerCase()).toContain("could not load");
}, 120000);

// =============================================================================
// 12. Identifier fallbacks: bonds, cash, numeric tickers, zero weights kept
// =============================================================================

test("12. bond rows fall back to identifiers; cash and zero-weight rows are kept", async () => {
  const app = await bootFresh();
  toggleRow(app, "BIL");
  toggleRow(app, "CWI");
  const oracle = expectedWatchlist(["BIL", "CWI"]);
  await waitForHoldingsSettled(app, 240000);
  expect(app.api().getDedupedWatchlistRows().length).toBe(oracle.size);
  expect(watchlistTabLabel(app).replace(/,/g, "")).toBe(String(oracle.size));

  const rows = app.api().getDedupedWatchlistRows();
  const tickers = new Set(rows.map((r: any) => String(r.symbol)));

  const bondByIdentifier = [...oracle.values()].filter((r) => r.key.startsWith("D:") || r.key.startsWith("C:") || r.key.startsWith("I:"));
  expect(bondByIdentifier.length).toBeGreaterThan(10);
  for (const sample of bondByIdentifier.slice(0, 25)) {
    expect(tickers.has(sample.shown)).toBe(true);
  }

  const cash = [...oracle.values()].find((r) => /DOLLAR|CASH|USD/i.test(r.shown) || r.key.includes("999USD"));
  expect(cash).toBeDefined();
  expect(tickers.has(cash!.shown)).toBe(true);

  const zeroWeight = [...oracle.values()].find((r) => r.hasWeight && r.weightSum === 0);
  expect(zeroWeight).toBeDefined();
  expect(tickers.has(zeroWeight!.shown)).toBe(true);
}, 300000);

test("12b. numeric local tickers are used as keys, not dropped", async () => {
  const app = await bootFresh();
  toggleRow(app, "CWI");
  const oracle = expectedWatchlist(["CWI"]);
  await waitForHoldingsSettled(app, 240000);
  expect(app.api().getDedupedWatchlistRows().length).toBe(oracle.size);
  const rows = app.api().getDedupedWatchlistRows();
  const tickers = new Set(rows.map((r: any) => String(r.symbol)));
  expect(oracle.has("T:8306")).toBe(true);
  expect(tickers.has("8306")).toBe(true);
  expect(rows.find((r: any) => String(r.symbol) === "8306").fundCount).toBe(1);
}, 300000);

// =============================================================================
// 13. Sticky columns
// =============================================================================

test("13. sticky classes are on catalog Use/Ticker and Watchlist Ticker cells", async () => {
  const app = await bootFresh();
  toggleRow(app, "SPY");
  await until(() => app.el("selected-tabs-bar").innerHTML.includes("Watchlist"));

  const head = app.el("table-head").innerHTML;
  expect(head).toContain("catalog-sticky-col catalog-sticky-use");
  expect(head).toContain("catalog-sticky-col catalog-sticky-ticker");
  const body = app.el("table-body").innerHTML;
  expect(body).toContain("catalog-sticky-col catalog-sticky-use");
  expect(body).toContain("catalog-sticky-col catalog-sticky-ticker");

  await clickTab(app, "watchlist");
  await until(() => app.api().state.activeTab === "watchlist");
  const wHead = app.el("table-head").innerHTML;
  const wBody = app.el("table-body").innerHTML;
  expect(wHead).toContain("watchlist-sticky-ticker");
  expect(wBody).toContain("watchlist-sticky-ticker");
}, 120000);

// =============================================================================
// 14. Malformed localStorage cannot crash boot
// =============================================================================

test("14. malformed localStorage is sanitized and boot still succeeds", async () => {
  const storage = new MemoryStorage();
  storage.setItem(SORTS_KEY, "{this is not json");
  storage.setItem(FILTERS_KEY, "{this is not json");
  storage.setItem(SITE_STATE_KEY, '{"sortKey": 42, "sheetSort": "oops"}');
  storage.setItem(SELECTED_KEY, "{broken");
  storage.setItem("spdr-blacklisted-etfs", "not-an-array");
  storage.setItem(ACTIVE_FUND_KEY, "  ###not a ticker### ");

  const app = await bootFresh(storage);
  expect(app.api().state.funds.length).toBeGreaterThan(100);
  expect(selectedTickers(app)).toEqual([]);
  expect(Object.keys(app.api().state.sortByTab).length).toBe(0);
  expect(Object.keys(app.api().state.queryByTab).length).toBe(0);
  expect(app.api().state.sortKey).toBe("rank");

  storage.setItem(SORTS_KEY, JSON.stringify({
    All: { key: "", dir: "asc" },
    watchlist: { key: "symbol", dir: "sideways" },
    "detail:holdings": { key: "col0", dir: "desc" },
  }));
  storage.setItem(FILTERS_KEY, JSON.stringify({
    All: 123,
    watchlist: "",
    "detail:holdings": "valid-query",
  }));
  const second = await bootFresh(storage);
  expect(Object.keys(second.api().state.sortByTab).length).toBe(1);
  expect(second.api().state.sortByTab["detail:holdings"]).toEqual({ key: "col0", dir: "desc" });
  expect(Object.keys(second.api().state.queryByTab).length).toBe(1);
  expect(second.api().state.queryByTab["detail:holdings"]).toBe("valid-query");
}, 120000);

// =============================================================================
// 15. Manifest consistency
// =============================================================================

test("15. index.json / meta.json / page manifests stay consistent", () => {
  const index = feedJson("index.json");
  expect(Array.isArray(index.funds)).toBe(true);
  expect(index.funds.length).toBeGreaterThan(0);
  for (const fund of index.funds) {
    if (!fund.holdings && !fund.history) continue;
    const meta = feedJson(`funds/${fund.ticker}/meta.json`);
    for (const kind of ["holdings", "history"] as const) {
      const manifest = meta[kind] ?? {};
      const pages: string[] = manifest.pages ?? [];
      expect(manifest.totalRows ?? 0).toBe(fund[kind] ?? 0);
      let rows = 0;
      for (const page of pages) {
        const payload = feedJson(`funds/${fund.ticker}/${page.replace(/^\.\//, "")}`);
        expect(Array.isArray(payload.headers)).toBe(true);
        expect(Array.isArray(payload.rows)).toBe(true);
        rows += payload.rows.length;
      }
      expect(rows).toBe(manifest.totalRows ?? 0);
    }
  }
}, 120000);

// =============================================================================
// 16. Per-tab filter persistence across views
// =============================================================================

test("16. per-tab filter persistence: each tab keeps its own search query independently", async () => {
  const app = await bootFresh();
  const catalogCount = catalogTickers().length;

  setSearch(app, "spy");
  const visibleFunds = visibleCatalogTickers(app);
  expect(visibleFunds.length).toBe(6);
  expect(app.el("ticker-count").textContent).toContain("6 ETFs");
  expect(JSON.parse(app.storage.getItem(FILTERS_KEY)!)).toEqual({ All: "spy" });

  toggleRow(app, "SPY");
  await until(() => app.el("selected-tabs-bar").innerHTML.includes("SPY Overview"));

  await clickTab(app, "detail:overview");
  await waitForTab(app, "detail:overview");
  expect(app.el("search-input").value).toBe("");
  expect(app.el("table-body").innerHTML).not.toContain("No overview metrics match your search");
  expect(app.el("table-body").innerHTML).toContain("YTD");

  setSearch(app, "return");
  expect(app.el("search-input").value).toBe("return");
  const overviewBody = app.el("table-body").innerHTML;
  expect(overviewBody).toContain("YTD");
  expect(overviewBody).not.toContain("Fund Name");
  expect(JSON.parse(app.storage.getItem(FILTERS_KEY)!)).toEqual({
    All: "spy",
    "detail:overview": "return",
  });
  expect(JSON.parse(app.storage.getItem(SITE_STATE_KEY)!).sheetFilter).toEqual({
    All: "spy",
    "detail:overview": "return",
  });

  await clickTab(app, "detail:holdings");
  await waitForTab(app, "detail:holdings");
  expect(app.el("search-input").value).toBe("");
  expect(app.el("table-body").innerHTML.toLowerCase()).not.toContain("no matching");

  setSearch(app, "nvidia");
  expect(app.el("search-input").value).toBe("nvidia");

  app.el("tabs-bar").querySelector("#all-etfs-tab-btn")!.click();
  await waitForTab(app, "All");
  expect(app.el("search-input").value).toBe("spy");
  expect(app.el("ticker-count").textContent).toContain("6 ETFs");

  await clickTab(app, "detail:overview");
  await waitForTab(app, "detail:overview");
  expect(app.el("search-input").value).toBe("return");

  await clickTab(app, "watchlist");
  await waitForTab(app, "watchlist");
  expect(app.el("search-input").value).toBe("");

  setSearch(app, "US");
  expect(app.el("search-input").value).toBe("US");

  const reloaded = await bootFresh(app.storage);
  expect(reloaded.el("search-input").value).toBe("spy");
  expect(reloaded.el("ticker-count").textContent).toContain("6 ETFs");
  expect(JSON.parse(reloaded.storage.getItem(FILTERS_KEY)!)).toEqual({
    All: "spy",
    "detail:overview": "return",
    "detail:holdings": "nvidia",
    watchlist: "US",
  });

  const searchClear = reloaded.el("search-clear-btn");
  expect(searchClear.classList.contains("hidden")).toBe(false);
  searchClear.click();
  expect(reloaded.el("search-input").value).toBe("");
  expect(searchClear.classList.contains("hidden")).toBe(true);
  expect(reloaded.el("ticker-count").textContent).toContain(`${catalogCount} ETFs`);
  expect(JSON.parse(reloaded.storage.getItem(FILTERS_KEY)!)).toEqual({
    "detail:overview": "return",
    "detail:holdings": "nvidia",
    watchlist: "US",
  });

  reloaded.el("reset-btn").click();
  expect(reloaded.el("search-input").value).toBe("");
  expect(reloaded.storage.getItem(FILTERS_KEY)).toBeNull();
  expect(reloaded.el("ticker-count").textContent).toContain(`${catalogCount} ETFs`);
}, 120000);

test("16b. 1-click clear button hides when empty and restores the unfiltered view", async () => {
  const app = await bootFresh();
  const catalogCount = catalogTickers().length;
  expect(app.el("search-clear-btn").classList.contains("hidden")).toBe(true);

  setSearch(app, "xlk");
  expect(app.el("search-clear-btn").classList.contains("hidden")).toBe(false);
  expect(app.el("search-input").value).toBe("xlk");
  expect(visibleCatalogTickers(app).length).toBeLessThan(catalogCount);

  app.el("search-clear-btn").click();
  expect(app.el("search-input").value).toBe("");
  expect(app.el("search-clear-btn").classList.contains("hidden")).toBe(true);
  expect(app.el("ticker-count").textContent).toContain(`${catalogCount} ETFs`);
  expect(app.storage.getItem(FILTERS_KEY)).toBeNull();
}, 60000);
