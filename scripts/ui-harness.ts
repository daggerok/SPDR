/**
 * Headless harness for the SPDR ETF UI (app.tsx).
 *
 * The published app is vanilla TypeScript compiled in the browser by Babel
 * standalone. This harness transpiles the same app.tsx with Bun, then
 * evaluates it inside a node:vm context wired to a small fake DOM,
 * localStorage, and a file-backed fetch() that serves the real generated
 * feed from api/spdr/. bun test can therefore exercise the production
 * selection writers, sort/filter persistence, Watchlist aggregation and
 * paging without a browser.
 */
import { readFile } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

const REPO_ROOT = path.join(__dirname, "..");
const APP_TSX = path.join(REPO_ROOT, "app.tsx");
const API_ROOT = path.join(REPO_ROOT, "api", "spdr");

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Fake DOM
// ---------------------------------------------------------------------------

type AttrConstraint = { name: string; value?: string };
type Selector = { tag?: string; id?: string; attrs: AttrConstraint[] };

function parseSelector(sel: string): Selector {
  const out: Selector = { attrs: [] };
  const rest = sel.replace(/#([A-Za-z0-9_-]+)/g, (_m, id) => {
    out.id = id;
    return "";
  });
  const tagMatch = /^([a-zA-Z][a-zA-Z0-9-]*)/.exec(rest.trim());
  if (tagMatch) out.tag = tagMatch[1].toLowerCase();
  for (const match of rest.matchAll(/\[([a-zA-Z-]+)(?:=\"([^\"]*)\")?\]/g)) {
    out.attrs.push({ name: match[1], value: match[2] });
  }
  return out;
}

export class FakeElement {
  tagName: string;
  id = "";
  dataset: Record<string, string> = {};
  attrs: Record<string, string> = {};
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  listeners = new Map<string, Array<(event: any) => void>>();
  classSet = new Set<string>();
  style: Record<string, string> = {};
  textContentValue = "";
  value = "";
  checked = false;
  disabled = false;
  hidden = false;
  offsetWidth = 0;
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 600;
  title = "";
  placeholder = "";
  private html = "";

  classList: {
    add: (...names: string[]) => void;
    remove: (...names: string[]) => void;
    toggle: (name: string, force?: boolean) => boolean;
    contains: (name: string) => boolean;
  };

  constructor(tag: string) {
    this.tagName = tag.toLowerCase();
    this.classList = {
      add: (...names: string[]) => {
        for (const name of names) this.classSet.add(name);
      },
      remove: (...names: string[]) => {
        for (const name of names) this.classSet.delete(name);
      },
      toggle: (name: string, force?: boolean) => {
        const wanted = force === undefined ? !this.classSet.has(name) : force;
        if (wanted) this.classSet.add(name);
        else this.classSet.delete(name);
        return wanted;
      },
      contains: (name: string) => this.classSet.has(name),
    };
  }

  get className() {
    return [...this.classSet].join(" ");
  }
  set className(next: string) {
    this.classSet = new Set(String(next || "").split(/\s+/).filter(Boolean));
  }

  setAttribute(name: string, value: string) {
    this.attrs[name] = String(value);
    if (name === "id") this.id = String(value);
    if (name === "title") this.title = String(value);
    if (name === "placeholder") this.placeholder = String(value);
    if (name.startsWith("data-")) {
      const key = name.slice(5).replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
      this.dataset[key] = String(value);
    }
    if (name === "class") {
      this.classSet = new Set(String(value).split(/\s+/).filter(Boolean));
    }
  }
  getAttribute(name: string) {
    return this.attrs[name] ?? null;
  }
  removeAttribute(name: string) {
    delete this.attrs[name];
  }

  get innerHTML() {
    return this.html;
  }
  set innerHTML(next: string) {
    this.html = String(next ?? "");
    parseChildrenInto(this, this.html);
  }
  insertAdjacentHTML(_pos: string, fragment: string) {
    this.html += String(fragment ?? "");
    parseChildrenInto(this, this.html);
  }
  get textContent() {
    return this.textContentValue;
  }
  set textContent(next: string) {
    this.textContentValue = String(next ?? "");
  }

  appendChild(child: FakeElement) {
    child.parent = this;
    this.children.push(child);
    return child;
  }
  removeChild(child: FakeElement) {
    this.children = this.children.filter((c) => c !== child);
    child.parent = null;
    return child;
  }
  remove() {
    if (this.parent) this.parent.removeChild(this);
  }
  contains(el: FakeElement) {
    let cur: FakeElement | null = el;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parent;
    }
    return false;
  }

  matchesSelector(sel: Selector): boolean {
    if (sel.tag && sel.tag !== this.tagName) return false;
    if (sel.id && sel.id !== this.id) return false;
    for (const attr of sel.attrs) {
      if (attr.name === "id") {
        if (this.id !== attr.value) return false;
        continue;
      }
      if (attr.name.startsWith("data-")) {
        const key = attr.name.slice(5).replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
        if (!(key in this.dataset)) return false;
        if (attr.value !== undefined && this.dataset[key] !== attr.value) return false;
        continue;
      }
      if (!(attr.name in this.attrs)) return false;
      if (attr.value !== undefined && this.attrs[attr.name] !== attr.value) return false;
    }
    return true;
  }

  private walk(visitor: (el: FakeElement) => void) {
    for (const child of this.children) {
      visitor(child);
      child.walk(visitor);
    }
  }

  querySelector(sel: string): FakeElement | null {
    return this.querySelectorAll(sel)[0] ?? null;
  }
  querySelectorAll(sel: string): FakeElement[] {
    const parsed = parseSelector(sel);
    const found: FakeElement[] = [];
    this.walk((el) => {
      if (el.matchesSelector(parsed)) found.push(el);
    });
    return found;
  }
  closest(sel: string): FakeElement | null {
    const parsed = parseSelector(sel);
    let cur: FakeElement | null = this;
    while (cur) {
      if (cur.matchesSelector(parsed)) return cur;
      cur = cur.parent;
    }
    return null;
  }

  addEventListener(type: string, fn: (event: any) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, fn: (event: any) => void) {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(type, list.filter((f) => f !== fn));
  }
  dispatch(type: string, init: Record<string, unknown> = {}) {
    const event = {
      type,
      target: this,
      preventDefault() {},
      stopPropagation() {},
      ...init,
    };
    for (const fn of this.listeners.get(type) ?? []) fn(event);
    return event;
  }
  click() {
    this.dispatch("click", { target: this });
  }

  getBoundingClientRect() {
    return { top: 120, left: 0, right: 1200, bottom: 700, width: 1200, height: 580 };
  }
  focus() {}
  blur() {}
  select() {}
}

function attrsFromTag(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of tag.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:]*)=\"([^\"]*)\"/g)) {
    attrs[match[1]] = match[2];
  }
  return attrs;
}

function makeFromTag(tagName: string, tag: string): FakeElement {
  const el = new FakeElement(tagName);
  const attrs = attrsFromTag(tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
  if (/\bchecked\b/.test(tag)) el.checked = true;
  if (/\bdisabled\b/.test(tag)) el.disabled = true;
  if (/\bhidden\b/.test(tag)) el.hidden = true;
  return el;
}

/**
 * Structural scan: enough to expose the interactive pieces the app queries
 * back (sort header buttons, catalog rows + checkboxes, tab buttons).
 */
function parseChildrenInto(container: FakeElement, html: string) {
  container.children = [];
  const openings: Array<{ index: number; end: number; tag: string }> = [];
  for (const match of html.matchAll(/<tr\b([^>]*)>/g)) {
    openings.push({ index: match.index ?? 0, end: (match.index ?? 0) + match[0].length, tag: match[0] });
  }
  const innerTag = /<(input|button|a)\b[^>]*?\/?>/g;

  const addFlat = (segment: string) => {
    for (const match of segment.matchAll(innerTag)) {
      container.appendChild(makeFromTag(match[1], match[0]));
    }
  };

  if (!openings.length) {
    addFlat(html);
    return;
  }

  addFlat(html.slice(0, openings[0].index));
  openings.forEach((opening, i) => {
    const nextStart = i + 1 < openings.length ? openings[i + 1].index : html.length;
    const body = html.slice(opening.end, nextStart);
    const row = makeFromTag("tr", opening.tag);
    container.appendChild(row);
    for (const match of body.matchAll(innerTag)) {
      row.appendChild(makeFromTag(match[1], match[0]));
    }
  });
}

// ---------------------------------------------------------------------------
// Storage / fetch shims
// ---------------------------------------------------------------------------

export class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string) {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, String(value));
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  clear() {
    this.map.clear();
  }
  get size() {
    return this.map.size;
  }
  snapshot(): Record<string, string> {
    return Object.fromEntries(this.map);
  }
  restore(snapshot: Record<string, string>) {
    this.map = new Map(Object.entries(snapshot));
  }
}

export type FetchStats = {
  counts: Map<string, number>;
  blocked: Set<string>;
  latency: (url: string) => number;
};

function createFeedFetch(stats: FetchStats) {
  return async function fetchStub(input: string): Promise<any> {
    const url = String(input);
    stats.counts.set(url, (stats.counts.get(url) ?? 0) + 1);
    const wait = stats.latency(url);
    if (wait > 0) await sleep(wait);
    const notFound = () => ({
      ok: false,
      status: 404,
      statusText: "Not Found",
      json: async () => {
        throw new Error(`404 for ${url}`);
      },
    });
    for (const blocked of stats.blocked) {
      if (url.includes(blocked)) return notFound();
    }
    const relative = url.replace(/^\.\//, "").replace(/^\/+/, "");
    if (!relative.startsWith("api/spdr/")) return notFound();
    const file = path.join(REPO_ROOT, relative);
    if (!existsSync(file)) return notFound();
    const data = await readFile(file, "utf8");
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => JSON.parse(data),
    };
  };
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

export type AppHandle = {
  ctx: vm.Context;
  run: <T = unknown>(code: string) => T;
  boot: () => Promise<void>;
  storage: MemoryStorage;
  stats: FetchStats;
  elements: Map<string, FakeElement>;
  el: (id: string) => FakeElement;
  api: () => any;
};

export async function createApp(options: { storage?: MemoryStorage } = {}): Promise<AppHandle> {
  const source = await readFile(APP_TSX, "utf8");
  const transpiler = new Bun.Transpiler({ loader: "tsx", target: "browser", trimUnusedImports: false });
  const appScript = transpiler.transformSync(source);

  const elements = new Map<string, FakeElement>();
  const staticIds = [
    "theme-toggle", "app-subtitle", "ticker-count", "search-input", "search-clear-btn", "tabs-bar",
    "selected-tabs-panel", "selected-tabs-bar", "table-head", "table-body",
    "table-scroll", "static-load-sentinel", "static-load-status",
    "copy-btn", "export-csv-btn", "export-txt-btn",
    "reset-btn", "blacklist-btn", "blacklist-panel", "blacklist-input",
    "blacklist-add-btn", "blacklist-clear-btn", "blacklist-chips", "blacklist-empty",
  ];
  for (const id of staticIds) {
    const el = new FakeElement(id === "search-input" ? "input" : id.endsWith("-btn") ? "button" : "div");
    el.id = id;
    if (id === "search-clear-btn") el.classList.add("hidden");
    elements.set(id, el);
  }
  elements.get("table-scroll")!.scrollHeight = 4000;
  elements.get("table-scroll")!.clientHeight = 600;

  const documentElement = new FakeElement("html");
  const body = new FakeElement("body");

  const documentShim: any = {
    documentElement,
    body,
    activeElement: null,
    addEventListener() {},
    removeEventListener() {},
    getElementById(id: string) {
      if (!elements.has(id)) {
        const el = new FakeElement("div");
        el.id = id;
        elements.set(id, el);
      }
      return elements.get(id)!;
    },
    createElement(tag: string) {
      return new FakeElement(tag);
    },
    execCommand() {
      return true;
    },
  };

  const storage = options.storage ?? new MemoryStorage();
  const stats: FetchStats = {
    counts: new Map(),
    blocked: new Set(),
    latency: () => 0,
  };

  const logs: Array<{ level: string; args: unknown[] }> = [];
  const quietConsole = {
    log: (...args: unknown[]) => logs.push({ level: "log", args }),
    info: (...args: unknown[]) => logs.push({ level: "info", args }),
    warn: (...args: unknown[]) => logs.push({ level: "warn", args }),
    error: (...args: unknown[]) => logs.push({ level: "error", args }),
    debug: () => {},
  };

  const sandbox: Record<string, unknown> = {
    console: quietConsole,
    document: documentShim,
    localStorage: storage,
    sessionStorage: new MemoryStorage(),
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: createFeedFetch(stats),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    URL: Object.assign(class extends URL {}, { createObjectURL: () => "blob:fake", revokeObjectURL() {} }),
    Blob: class {
      constructor(public parts: unknown[], public options: unknown) {}
    },
    __logs: logs,
  };
  sandbox.globalThis = sandbox;
  sandbox.window = Object.assign(sandbox, {
    addEventListener() {},
    removeEventListener() {},
    innerWidth: 1440,
    innerHeight: 900,
    location: { reload() {} },
  });

  const ctx = vm.createContext(sandbox);
  vm.runInContext(appScript, ctx, { filename: "app.tsx" });

  const run = <T = unknown>(code: string): T => vm.runInContext(code, ctx) as T;

  const boot = async () => {
    const start = Date.now();
    while (true) {
      const n = run<number>("(__SPDR_APP__ && __SPDR_APP__.getTestApi().state.funds.length) || 0");
      if (n > 0) break;
      if (Date.now() - start > 30000) throw new Error("Timed out waiting for catalog boot");
      await sleep(20);
    }
    await sleep(20);
  };

  return {
    ctx,
    run,
    boot,
    storage,
    stats,
    elements,
    el: (id: string) => documentShim.getElementById(id),
    api: () => run("__SPDR_APP__.getTestApi()"),
  };
}

// ---------------------------------------------------------------------------
// Feed oracle helpers (independent of the UI code, used as expected values)
// ---------------------------------------------------------------------------

export function feedJson(relative: string): any {
  return JSON.parse(readFileSync(path.join(API_ROOT, relative), "utf8"));
}

export function catalogTickers(): string[] {
  return feedJson("index.json").funds.map((fund: any) => fund.ticker);
}

export function fundHoldingRows(ticker: string): Array<Record<string, unknown>> {
  let meta: any;
  try {
    meta = feedJson(`funds/${ticker}/meta.json`);
  } catch {
    return [];
  }
  const pages: string[] = meta?.holdings?.pages ?? [];
  const rows: Array<Record<string, unknown>> = [];
  for (const page of pages) {
    const payload = feedJson(`funds/${ticker}/${page.replace(/^\.\//, "")}`);
    const headers: string[] = payload.headers ?? [];
    for (const raw of payload.rows ?? []) {
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        rows.push(raw);
      } else if (Array.isArray(raw)) {
        const obj: Record<string, unknown> = {};
        headers.forEach((header, index) => {
          obj[header] = raw[index];
        });
        rows.push(obj);
      }
    }
  }
  return rows;
}

const PLACEHOLDER_VALUES = new Set(["", "-", "--", "—", "–", "N/A", "NA", "NONE", "NULL"]);

/** Treats blank / dash / N/A style placeholders as missing (spec §E). */
export function cleanFeedValue(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!text || PLACEHOLDER_VALUES.has(text.toUpperCase())) return "";
  return text;
}

/**
 * Documented dedupe key fallback order:
 * Ticker -> CUSIP -> ISIN -> Identifier/Security ID -> SEDOL/FIGI -> Name.
 */
export function watchlistKey(row: Record<string, unknown>): { key: string; shown: string } | null {
  const first = (...values: unknown[]) => {
    for (const value of values) {
      const clean = cleanFeedValue(value);
      if (clean) return clean;
    }
    return "";
  };
  const ticker = first(row.Ticker, row.Symbol);
  if (ticker) return { key: `T:${ticker.toUpperCase()}`, shown: ticker };
  const cusip = first(row.CUSIP);
  if (cusip) return { key: `C:${cusip.toUpperCase()}`, shown: cusip };
  const isin = first(row.ISIN);
  if (isin) return { key: `I:${isin.toUpperCase()}`, shown: isin };
  const identifier = first(row.Identifier, row["Security ID"]);
  if (identifier) return { key: `D:${identifier.toUpperCase()}`, shown: identifier };
  const sedol = first(row.SEDOL, row.FIGI);
  if (sedol) return { key: `S:${sedol.toUpperCase()}`, shown: sedol };
  const name = first(row.Name, row["Security Name"]);
  if (name) return { key: `N:${name.toUpperCase()}`, shown: name };
  return null;
}

export function parseFeedNumber(value: unknown): number | null {
  const source = String(value ?? "").trim();
  if (!source || source === "—") return null;
  const normalized = source.replace(/^\((.*)\)$/, "-$1").replace(/[$,%]/g, "").replace(/,/g, "").trim();
  return /^-?(?:\d+|\d*\.\d+)$/.test(normalized) ? Number(normalized) : null;
}

export type ExpectedRow = {
  key: string;
  shown: string;
  funds: Set<string>;
  weightSum: number;
  maxWeight: number;
  hasWeight: boolean;
  marketValueSum: number;
  hasMarketValue: boolean;
};

/** Independently computes the expected deduplicated Watchlist aggregation. */
export function expectedWatchlist(tickers: string[]): Map<string, ExpectedRow> {
  const map = new Map<string, ExpectedRow>();
  for (const ticker of tickers) {
    for (const row of fundHoldingRows(ticker)) {
      const resolved = watchlistKey(row);
      if (!resolved) continue;
      let item = map.get(resolved.key);
      if (!item) {
        item = {
          key: resolved.key,
          shown: resolved.shown,
          funds: new Set(),
          weightSum: 0,
          maxWeight: Number.NEGATIVE_INFINITY,
          hasWeight: false,
          marketValueSum: 0,
          hasMarketValue: false,
        };
        map.set(resolved.key, item);
      }
      item.funds.add(ticker);
      const weight = parseFeedNumber(row.Weight ?? row["Weight (%)"]);
      if (weight !== null) {
        item.hasWeight = true;
        item.weightSum += weight;
        item.maxWeight = Math.max(item.maxWeight, weight);
      }
      const marketValue = parseFeedNumber(row["Market Value"]);
      if (marketValue !== null) {
        item.hasMarketValue = true;
        item.marketValueSum += marketValue;
      }
    }
  }
  return map;
}
