# SPDR

SPDR ETF holdings to Watchlist. A single-file client-side tool that reads the generated `api/spdr/**` static feed (SSGA / State Street public data) into a searchable ETF / asset-class catalog with per-fund holdings, NAV-history and distributions tabs, Watchlist aggregation across selected ETFs, ticker copy and CSV/TXT export. Vanilla inline TypeScript + TailwindCSS, light/dark theme, no build step.

## Sibling applications

| Application | Data provider | Repository |
|---|---|---|
| Amplify ETF Holdings to Watchlist | Amplify ETFs (Firestore data feed) | [daggerok/Amplify](https://github.com/daggerok/Amplify) · [published app](https://daggerok.github.io/Amplify/) |
| iShares Excel .xls to Watchlist | iShares (BlackRock) product workbooks | [daggerok/iShares](https://github.com/daggerok/iShares) · [published app](https://daggerok.github.io/iShares/) |
| SPDR ETF Holdings to Watchlist | SSGA / State Street public feeds | [daggerok/SPDR](https://github.com/daggerok/SPDR) · [published app](https://daggerok.github.io/SPDR/) |

## Using Bun

```bash
bunx degit daggerok/SPDR#main ./12345 && cd $_
bunx serve . -p 1234
open http://0:1234
```

The published application is available at <https://daggerok.github.io/SPDR/>.

## Updating the static SPDR data

Run the updater with Bun:

```bash
bun install --frozen-lockfile
bun test scripts/update-data.test.ts
./scripts/update-data.ts
```

Run `./scripts/update-data.ts -h` (or `--help`) to print every configuration variable with its default and usage examples. All supplied filters use **AND** logic.

The **Update SPDR ETF data** GitHub Actions workflow exposes the same settings as manual inputs.

### Data sources

Everything comes from public SSGA feeds, fetched politely (they rate-limit hard):

| Block | Source |
|---|---|
| Catalog (179 US ETFs) | `ssga.com/bin/v1/ssmp/fund/fundfinder?country=us&language=en&role=intermediary&product=etfs&ui=fund-finder` |
| Daily holdings | `ssga.com/library-content/products/fund-data/etfs/us/holdings-daily-us-en-{ticker}.xlsx` |
| NAV history | `ssga.com/library-content/products/fund-data/etfs/us/navhist-us-en-{ticker}.xlsx` |
| Distributions | `ssga.com/bin/v1/ssmp/fund/dividend-distribution?country=us&language=en&role=intermediary` |

The catalog provides name, asset class (Type), TER (Expense), NAV, AUM (Net Assets), exchange, close price, premium/discount, inception, month-end and quarter-end NAV returns and document links. Each fund also carries a derived `metrics` object that powers the catalog table columns shared with the sibling sites:

- `ytd` — cumulative YTD (SSGA "Month End") → *YTD Return*
- `tr1y` — 1-year total return → *TR 1Y*
- `tr3y`/`tr5y`/`tr10y` — cumulative total returns **derived** from SSGA's published annualized figures: `(1 + CAGR nY)^n − 1` (the exact inverse of annualizing, so no precision is lost) → *TR 3Y/5Y/10Y*
- `cagr3y`/`cagr5y`/`cagr10y` — SSGA's annualized returns, used directly → *CAGR 3Y/5Y/10Y*
- `siAnn` — since-inception annualized → *SI Ann.*
- `dividendYield` — **indicated** yield: latest distribution × payments per year ÷ NAV → *Dividend Yield*
- `secYield` — always `null` → *SEC Yield* renders as `—`

Known value limitations (SSGA does not publish these for SPDR ETFs):

- **SEC Yield (30-day)** — no source endpoint; shown as `—`.
- **Dividend Yield** is *indicated*, not trailing-12M: SSGA exposes only the latest distribution per fund, so the yield assumes every distribution in the year equals the latest one.
- Multi-year **total returns** are derived from annualized figures rather than published cumulative ones (mathematically exact, but tiny rounding differences vs. SSGA's own cumulative display are possible). Equity and bond holdings workbooks have different column sets (bonds have no `Ticker` column — they are identified by `Identifier`); both formats are stored as-is with per-fund headers, and the Watchlist deduplicates by `Ticker` when present, falling back to `Identifier`. Commodity trusts (`GLD`, `GLDM`) publish no holdings workbook and are catalog-only.

### Update controls

| Environment variable | Default | Meaning |
|---|---:|---|
| `MAX_FETCHES` | all | Maximum eligible fund update attempts per run. With a positive value, the updater continues after the committed cursor in `api/spdr/update-state.json`; empty or `0` means all. |
| `REQUEST_SLEEP` | `1` | Minimum delay in seconds between outgoing request starts, including retries. Decimal values are accepted. Keep it at `1` or above: SSGA front doors answer `403` while rate-limited. |
| `AUM` | `:` | Net Assets range. Each bound may be a USD amount (`K`, `M`, `B`, `T` suffixes allowed) or `nano`, `micro`, `small`, `mid`, or `large`. |
| `TER` | `:` | Inclusive gross expense-ratio percentage range. |
| `CONCURRENCY` | `2` | Number of parallel fund update workers. Request starts are still globally spaced by `REQUEST_SLEEP`. |
| `HOLDINGS_PAGE_SIZE` | `250` | Rows in each generated current-holdings JSON page. |
| `HISTORY_PAGE_SIZE` | `1000` | Rows in each generated NAV-history JSON page. |
| `STORE_RAW_DOWNLOADS` | off | Store the latest source XLSX under `api/spdr/raw`. Values `1`, `true`, `yes`, `y`, and `on` enable it. |
| `MAX_RETRIES` | `2` | Retries after the initial request. Rate-limited `403` answers back off 15s/30s/… before retrying. Only network errors, HTTP 408/425/429, 5xx and rate-limit `403` are retried. |
| `TICKERS` | all | Space-, comma-, or semicolon-separated ticker allowlist, for example `SPY XLK SPAB`. |

`TICKERS` combines with AUM, TER and return filters using AND logic; it does not override them. Funds not selected for a successful update keep their previously published metadata and data files.

### Resuming bounded runs

A positive `MAX_FETCHES` is a batch size, not a permanent limit. Eligible funds are kept in deterministic ticker order and the updater starts after `lastProcessedTicker` in `api/spdr/update-state.json`, wrapping to the beginning when it reaches the end. The state file is updated only for a bounded run that had candidates; `MAX_FETCHES=0` processes every eligible fund and does not move the cursor. Delete the file to restart from the first eligible ticker.

### Strict range syntax

Every non-empty range must contain **exactly one colon**. Empty input and `:` both mean no restriction.

| Value | Valid | Meaning |
|---|:---:|---|
| empty | yes | no restriction |
| `:` | yes | no restriction |
| `:900000` | yes | maximum 900000 |
| `12345678:123456789` | yes | inclusive minimum and maximum |
| `1234567:` | yes | minimum 1234567 |
| `123456789` | **no** | colon is missing |

Percent signs are optional, so `1%:4.5%` and `1:4.5` are equivalent. A configured minimum must not exceed its maximum.

### AUM ranges and presets

Preset boundaries are:

```text
nano:     $0 <= AUM < $10M
micro:    $10M <= AUM < $300M
small:    $300M <= AUM < $2B
mid:      $2B <= AUM < $10B
large:    AUM >= $10B
```

A preset on the left contributes its lower boundary; on the right it contributes its exclusive upper boundary (`micro:small` is `$10M <= AUM < $2B`). Numeric bounds are inclusive amounts (`300M:2B` is `$300M <= AUM <= $2B`).

### Return ranges

SSGA publishes two NAV return series; both use the same strict `min:max` syntax:

```text
PERFORMANCE_YTD|1Y|3Y|5Y|10Y   month-end series   (3Y+ are CAGR)
TOTAL_RETURN_YTD|1Y|3Y|5Y|10Y  quarter-end series (3Y+ are CAGR)
```

`PERFORMANCE_*` filters the month-end NAV series used by the catalog table; `TOTAL_RETURN_*` filters the quarter-end series shown in each fund's Overview tab. YTD values are cumulative. A young fund missing a requested 3Y/5Y/10Y metric passes the filter (missing history never fails a return filter); missing AUM or TER does fail an active catalog filter. Since-inception returns are stored but intentionally not filterable.

### Examples

Update only three ETFs:

```bash
TICKERS="SPY XLK SPAB" ./scripts/update-data.ts
```

Cheap broad-market equity funds of at least $10B with no more than a 0.10% expense ratio:

```bash
AUM="large:" TER=":0.1" ./scripts/update-data.ts
```

Next bounded batch of 20 funds with at least a 5% three-year CAGR:

```bash
MAX_FETCHES=20 PERFORMANCE_3Y="5:" ./scripts/update-data.ts
```

## Developer notes

- Updater controls belong to `workflow_dispatch` and are visible on the GitHub Actions **Run workflow** form. They are not controls in the published web application.
- The workflow is manual. Merging updater code changes does not run a data update automatically.
- A successful data run may commit only `api/spdr/**`. GitHub Pages then deploys that commit, but the catalog UI changes only when the generated data itself changed.
- Catalog-only filters (`TICKERS`, `AUM`, `TER`) run before `MAX_FETCHES`; return filters run on catalog values before each download.
- The updater is dependency-free: the daily XLSX workbooks are real OOXML zips, unzipped with `node:zlib` and parsed with a hand-rolled minimal SpreadsheetML reader (`readZipEntries` + `parseXlsxSheet` in `scripts/update-data.ts`).
- Only useful worksheets are stored, never the raw XLSX (unless `STORE_RAW_DOWNLOADS` is on). Rows are written as paginated JSON only when their content changed, so a rerun with unchanged data produces an empty `git diff`.
- The UI fetches the first Holdings/History page and appends more rows automatically as the table is scrolled; it does not show page-number controls.
- The **Watchlist** tab aggregates the holdings of every selected ETF. Its **# ETFs** column counts how many of the selected ETFs hold each ticker, right after the **ETFs** badge column. Bond rows without a `Ticker` column are keyed by `Identifier` (CUSIP/ISIN).
- Any ETF can be **blacklisted**: click the small ✕ next to a fund's Use checkbox (row click → Overview also selects a fund) or type tickers into the **Blacklist** panel in the toolbar. Blacklisted ETFs disappear from All ETFs (and from selection); the list is kept per browser in localStorage.
- The app keeps search and sort preferences in localStorage and reapplies them after reload.
- Only the table area scrolls: the app sizes `#table-scroll` to the remaining viewport height and contains overscroll, so the document itself does not jump up and down when the table is taller than the screen (fix also applied to daggerok/iShares).
- GitHub Actions writes updated, unchanged, skipped, and failed counts to the workflow summary.
- Range validation is centralized in `parseRange`/`parseAumRange`; add or change syntax there and update `scripts/update-data.test.ts` in the same PR.

Before opening a PR, run:

```bash
bun install --frozen-lockfile
bun test scripts/update-data.test.ts
bunx tsc --noEmit \
  --target es2022 \
  --module esnext \
  --moduleResolution bundler \
  --types bun,node \
  --skipLibCheck \
  scripts/update-data.ts \
  scripts/update-data.test.ts

git diff --check
```

## TypeScript

The browser app is intentionally single-file: `index.html` contains inline TypeScript compiled in the browser with Babel standalone, following the `daggerok/youtube` no-src-files approach (same as daggerok/Amplify).

## Brands table

| Бренд                        | Фонды | Где брать данные |
|------------------------------|---|---|
| **SPDR / State Street** (14) ✅ | SPYM, SPYG, SPYD, SDY, XTL, XLK, XLF, XLV, XLY, XLU, XLC, XLI, XLP, XLE | [us.spdrs.com](https://us.spdrs.com/) · [каталог ssga.com](https://www.ssga.com/us/en/intermediary/etfs/fund-finder) · секторы: [selectsectorspdrs.com](https://www.selectsectorspdrs.com/) — весь каталог SSGA уже интегрирован в наше приложение [daggerok/SPDR](https://github.com/daggerok/SPDR) |
| **Invesco** (14)             | QQQM, RSP, SPLV, SPHD, SPMO, SPHQ, SPGP, RPV, RPG, RWL, DBA, IDMO, IDHQ, IDLV | [invesco.com `?ticker=`](https://www.invesco.com/us/financial-products/etfs/product-detail?ticker=IDHQ) |
| **iShares / BlackRock** (14) ✅ | IVV, SGOV, DGRO, SOXX, MTUM, DVY, HDV, IAUM, PICK (Global Metals & Mining), GARP (MSCI USA Quality GARP), SLVP (Global Silver Miners), RING (Global Gold Miners) | [www.ishares.com](https://www.ishares.com/) · XLS-экспорт holdings со страниц фондов (уже интегрирован в наше приложение, весь каталог) |
| **Vanguard** (10)            | VOO, VUG, VTV, VIG, VYM, VGT, MGK, VOOG, VIGI, VYMI | [investor.vanguard.com](https://investor.vanguard.com/investment-products/etfs) → `…/profile/VOO` |
| **Fidelity** (5)             | FTEC, FDVV, FDIS, FCOM, FNILX* | [fidelity.com/etfs](https://www.fidelity.com/etfs) · [fundresearch.fidelity.com](https://fundresearch.fidelity.com/) — *FNILX вообще не ETF, а взаимный фонд ZERO |
| **Schwab** (3)               | SCHD, SCHG, SCHB | [schwabassetmanagement.com/products/schd](https://www.schwabassetmanagement.com/products/schd) |
| **VanEck** (3)               | SMH, GDX, GDXJ | [vaneck.com/etf/smh/](https://www.vaneck.com/etf/smh/) |
| **Amplify** (3) ✅              | DIVO, IDVO (CWP Intl Enhanced Dividend), SILJ (Junior Silver Miners, экс-ETFMG) | [amplifyetfs.com](https://amplifyetfs.com/) · Firestore-фид данных (уже интегрирован в наше приложение) |
| **JPMorgan** (2)             | JEPI, JEPQ | [JEPI](https://am.jpmorgan.com/us/en/asset-management/adv/products/jpmorgan-equity-premium-income-etf-etf-shares-46641q332) · [JEPQ](https://am.jpmorgan.com/us/en/asset-management/adv/products/jpmorgan-nasdaq-equity-premium-income-etf-etf-shares-46654q203) |
| **Global X** (2)             | URA, SIL | [globalxetfs.com/funds/ura/](https://www.globalxetfs.com/funds/ura/) |
| **abrdn** (2)                | SGOL, SIVR | [abrdn.com](https://www.abrdn.com) → Investments → ETFs |
| **NEOS** (2)                 | SPYI, QQQI | [neosfunds.com](https://neosfunds.com/) |
| **Goldman Sachs** (2)        | GPIX, GPIQ | [GSAM.com/ETFs](https://www.gsam.com/etfs) |
| **Sprott** (2)               | SGDM, SGDJ | [sprott.com/investments](https://sprott.com/investments/) |
| **First Trust** (1)          | RDVY | [ftportfolios.com](https://www.ftportfolios.com/Retail/etf/etfsummary.aspx?ticker=RDVY) |
| **WisdomTree** (1)           | DGRW | [wisdomtree.com/investments/etfs/dgrw](https://www.wisdomtree.com/investments/etfs/dgrw) |
| **Capital Group** (1)        | CGDV | [capitalgroup.com/etf/cgdv.html](https://www.capitalgroup.com/etf/cgdv.html) |
| **FlexShares** (1)           | GUNR | [flexshares.com/us/en/individual/funds/gunr](https://www.flexshares.com/us/en/individual/funds/gunr) |
| **Roundhill** (1)            | DRAM | [roundhillinvestments.com/etf/dram/](https://www.roundhillinvestments.com/etf/dram/) |
| **ProShares** (1)            | ISPY | [proshares.com](https://www.proshares.com/our-etfs/strategic/ispy) |
| **Themes ETFs** (1)          | AGMI | [themesetfs.com/etfs/agmi](https://themesetfs.com/etfs/agmi) |
| **SP Funds** (1)             | SPWO (шариат-фонд) | [sp-funds.com](https://www.sp-funds.com/) |

## Brands list

#	Бренд	Фонды из списка (кол-во)	Официальный сайт / страницы фондов
1	SPDR / State Street — 14 ✅	SPYM (бывш. SPLG), SPYG, SPYD, SDY, XTL + секторы XLK, XLF, XLV, XLY, XLU, XLC, XLI, XLP, XLE	https://us.spdrs.com/ · каталог: https://www.ssga.com/us/en/intermediary/etfs/fund-finder · секторы: https://www.selectsectorspdrs.com/ — весь каталог SSGA (179 фондов) уже интегрирован в наше приложение https://github.com/daggerok/SPDR
2	Invesco — 14	QQQM, RSP, SPLV, SPHD, SPMO, SPHQ, SPGP, RPV, RPG, RWL, DBA, IDMO, IDHQ, IDLV	https://www.invesco.com/us/financial-products/etfs/product-detail?ticker=IDHQ (паттерн ?ticker={TICKER})
3	iShares (BlackRock) — 12 ✅	IVV, SGOV, DGRO, SOXX, MTUM, DVY, HDV, IAUM, PICK (Global Metals & Mining), GARP (MSCI USA Quality GARP), SLVP (Global Silver Miners), RING (Global Gold Miners)	https://www.ishares.com/ — XLS-экспорт holdings со страниц фондов (уже интегрирован в наше приложение, весь каталог)
4	Vanguard — 10	VOO, VUG, VTV, VIG, VYM, VGT, MGK, VOOG, VIGI, VYMI	https://investor.vanguard.com/investment-products/etfs — профиль фонда: …/etfs/profile/VOO
5	Fidelity — 5	FTEC, FDVV, FDIS, FCOM, FNILX*	https://www.fidelity.com/etfs · исследование: https://fundresearch.fidelity.com/ (*FNILX — взаимный фонд ZERO, не ETF)
6	Schwab Asset Management — 3	SCHD, SCHG, SCHB	https://www.schwabassetmanagement.com/products/schd (паттерн /products/{ticker})
7	VanEck — 3	SMH, GDX, GDXJ	https://www.vaneck.com/etf/smh/ (паттерн /etf/{ticker}/)
8	Amplify — 3 ✅	DIVO, IDVO (CWP Intl Enhanced Dividend), SILJ (Junior Silver Miners, экс-ETFMG)	https://amplifyetfs.com/ — Firestore-фид данных (уже интегрирован в наше приложение)
9	JPMorgan Asset Management — 2	JEPI, JEPQ	https://am.jpmorgan.com/us/en/asset-management/adv/products/jpmorgan-equity-premium-income-etf-etf-shares-46641q332 · …/jpmorgan-nasdaq-equity-premium-income-etf-etf-shares-46654q203
10	Global X — 2	URA, SIL	https://www.globalxetfs.com/funds/ura/ (паттерн /funds/{ticker}/)
11	abrdn — 2	SGOL, SIVR	https://www.abrdn.com (раздел Investments → ETFs; физическое золото/серебро, daily bar list)
12	NEOS — 2	SPYI, QQQI	https://neosfunds.com/ · https://neosfunds.com/spyi-lp/ · https://neosfunds.com/qqqi-lp/
13	Goldman Sachs (GSAM) — 2	GPIX, GPIQ	https://www.gsam.com/etfs (GSAM.com/ETFs) · GPIX: https://www.gsam.com/content/gsam/us/en/advisors/fund-center/etf-fund-finder/goldman-sachs-s&p-500-core-premium-income-etf.html
14	Sprott — 2	SGDM, SGDJ	https://sprott.com/investments/ · https://api.sprott.com/sgdm-sprott-gold-miners-etf/ · …/sgdj-sprott-junior-gold-miners-etf/
15	First Trust — 1	RDVY (Rising Dividend Achievers)	https://www.ftportfolios.com/Retail/etf/etfsummary.aspx?ticker=RDVY
16	WisdomTree — 1	DGRW	https://www.wisdomtree.com/investments/etfs/dgrw
17	Capital Group — 1	CGDV (Dividend Value)	https://www.capitalgroup.com/etf/cgdv.html (паттерн /etf/{ticker}.html)
18	FlexShares (Northern Trust) — 1	GUNR	https://www.flexshares.com/us/en/individual/funds/gunr
19	Roundhill — 1	DRAM (Memory ETF, зап. 04/2026)	https://www.roundhillinvestments.com/etf/dram/
20	ProShares — 1	ISPY (S&P 500 High Income)	https://www.proshares.com/our-etfs/strategic/ispy
21	Themes ETFs — 1	AGMI (Silver Miners)	https://themesetfs.com/etfs/agmi (паттерн /etfs/{ticker})
22	SP Funds (ShariaPortfolio) — 1	SPWO (S&P World ex-US, шариат)	https://www.sp-funds.com/
