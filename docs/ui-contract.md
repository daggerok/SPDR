# SPDR ETF UI contract

Shared interaction and data-state rules for the SPDR Watchlist application
(`index.html` + `app.tsx`). Sibling provider apps (Vanguard, iShares, Amplify,
WisdomTree, …) implement the same contract with a provider-prefixed storage
key. Headless acceptance coverage lives in `scripts/ui.test.ts`.

## Storage keys

| Key | Purpose |
|---|---|
| `spdr-tab-filters` | Explicit per-tab search queries. JSON map `tabId -> filterString`. Empty queries are omitted; the key is removed when no tab has a filter. |
| `spdr-searches` | Legacy filter map. Read on boot, then migrated into `spdr-tab-filters` and deleted. |
| `spdr-tab-sorts` | Explicit per-tab sorts. JSON map `tabId -> { key, dir }`. Defaults are never written. |
| `spdr-site-state` | Compatibility blob: `{ activeTab, activeFundTicker, sheetFilter, sheetSort }`. `sheetFilter` mirrors `spdr-tab-filters`. |
| `spdr-selected-etfs` | Selected ticker list. |
| `spdr-blacklisted-etfs` | Hidden ticker list. |
| `spdr-active-fund` | Active fund ticker for detail tabs. |
| `spdr-theme` | `dark` / `light`. |

Boot sanitization: malformed JSON, arrays, non-string filter values, empty
sort keys, and unknown sort directions are dropped. Restoration never throws.

Tab ids used as map keys:

- Catalog: `All` plus each SSGA asset-class name (`Equity`, `Fixed Income Sector`, …)
- Detail: `detail:overview`, `detail:holdings`, `detail:history`, `detail:distributions`
- Watchlist: `watchlist`

## Per-tab search filters

- `#search-input` reflects and mutates only the active tab's query.
- Switching tabs restores that tab's query (or `""` when the tab was never filtered).
- A tab without an explicit filter renders its full dataset.
- `#search-clear-btn` (✕, matching the Use-column blacklist glyph) is hidden
  when the input is empty. Clicking it clears only the active tab's filter,
  focuses the input, and re-renders immediately.
- **Clear** (`#reset-btn`) wipes selection and every tab filter. Remembered
  sorts survive.

`switchTab(tab)` saves `searchInput.value` into the outgoing tab **only when
the destination differs from the current tab**, so boot-time hydration cannot
overwrite a restored query.

## Per-tab sorts

- Explicit header clicks are stored in `spdr-tab-sorts` and restored on tab
  switch and full reload.
- Tabs that were never sorted keep defaults:
  - Watchlist: `weightSum` desc
  - Overview: `section` asc
  - Catalog and detail sheets: source order (`rank` asc)
- Defaults are never written to storage.
- No button or checkbox may reset sorting: not row Use, header Use, All ETFs
  pill, tab buttons, search, Copy Tickers, exports, blacklist, theme, or Clear.

## Selection scopes

| Control | Scope | Checked state |
|---|---|---|
| Row Use checkbox | Exactly one ETF | that ticker ∈ selection |
| Header Use checkbox | Visible catalog rows (current tab + search filter + blacklist exclusion) | `.every(...)` over those rows |
| All ETFs pill checkbox | Every non-blacklisted catalog ETF | `.every(...)` over the whole catalog |

The All ETFs pill is toggle-only: it never navigates away from the current
view and works from Catalog, detail, and Watchlist under any filter.

Unchecking the header Use box deselects **only** the currently visible rows;
selections hidden by another filter survive.

## Immediate selection reactivity

Any selection change (row, header, pill, blacklist, Clear) immediately updates:

- Subtitle count and clickable ticker badges (active fund highlighted)
- Active-fund fallback (first remaining selected ticker)
- Detail-tab panel visibility and per-sheet counts
- Watchlist tab visibility, loading state, and count
- `localStorage` (`spdr-selected-etfs`, `spdr-active-fund`)

## Watchlist aggregation

- Loading feedback: `Watchlist (Loading…)` when nothing is aggregated yet,
  `Watchlist (N+)` while pages stream in, exact deduplicated count only after
  every selected fund finishes (or fails).
- `loadFundMeta` is deduplicated per ticker via an in-flight promise map.
- `ensureAllHoldingsForTicker` is exactly one holdings-page loader per ticker;
  concurrent callers await the same promise; the cache is written once.
- Whole-catalog aggregation uses a concurrency queue bounded at 6 workers.
  Queued work for deselected ETFs is skipped.
- Dedup key fallback, namespaced to prevent collisions:

  `Ticker` → `CUSIP` → `ISIN` → `Identifier` / `Security ID` → `SEDOL` / `FIGI` → `Name`

  Prefixes: `T:`, `C:`, `I:`, `D:`, `S:`, `N:`.

  Placeholders `""`, `"-"`, `"--"`, `"—"`, `"N/A"`, `"NA"`, `"NONE"`, `"NULL"`
  are treated as missing. Numeric local listing tickers (`005930`, `8306`)
  are valid keys. Bond, cash (`USD` / `CASH` / `US DOLLAR`), derivative, and
  zero-weight rows are never dropped.
- Watchlist renders in chunks of 250 rows; scrolling extends the chunk.
  Copy Tickers / CSV / TXT always operate on the complete filtered dataset.

## Detail view states & sticky columns

- Switching funds shows an immediate loading placeholder, never the previous
  fund's table.
- Network/fetch failures render `Could not load <TICKER> data`.
- Catalog-only funds (no workbook, e.g. `GLD`) render an explanatory empty
  state rather than a spinner.
- Sticky classes applied directly to `th`/`td` with opaque backgrounds:
  - Catalog: `#table-scroll .catalog-sticky-use` (left: 0) and `.catalog-sticky-ticker`
  - Watchlist: `#table-scroll .watchlist-sticky-ticker` (left: 0)

## Test checklist

`bun test` (see `scripts/ui.test.ts`) covers:

1. Sort round-trip across tabs, select-alls, search, exports, theme, Clear, reload
2. Header Use selects only the filtered subset
3. Header Use uncheck preserves hidden selections
4. All ETFs pill toggles the whole catalog from detail/Watchlist without navigating
5. Watchlist `Loading…` / `N+` then exact count
6. Rapid overlapping selections fetch each holdings page exactly once
7. Deselection updates subtitle, tabs, and Watchlist synchronously
8. Whole-catalog aggregate with 250-row DOM chunks
9. Reload restores selection, active fund, and Watchlist
10. Overview / Holdings / History / Distributions render real rows
11. Failed fund files show `Could not load <TICKER> data`
12. Identifier fallbacks, cash, zero-weight, numeric tickers
13. Sticky classes on catalog Use/Ticker and Watchlist Ticker
14. Malformed `localStorage` is sanitized
15. `index.json` / `meta.json` / page row counts match
16. Per-tab search persistence and 1-click `#search-clear-btn`
