# SPDR

One of the app's features lets you select SPDR ETFs in the Watchlist and aggregate their holdings to see how often each ticker appears across the selected funds. Repeated holdings make overlapping exposure visible: the more selected funds include a ticker, the greater its potential influence on the portfolio; gains in that holding may help, while declines may hurt, and actual impact also depends on each fund's position size.  Another feature makes it faster and easier to find funds with stronger growth over different periods, higher dividend yields or distributions, greater Total Return (price performance plus dividends), and other key performance metrics. A single-file client-side tool that reads the generated `./api/spdr` static feed (SSGA daily holdings XLSX, NAV history XLSX, daily premium/discount history XLSX, the bulk product-data XLSX for ISIN/CUSIP/official SEC and dividend yield, distributions) into a searchable ETF/asset-class catalog with per-fund tabs, watchlist aggregation, ticker copy and CSV/TXT export — the same look, feel, columns and business logic as the sibling applications.

## Using Bun

```bash
bunx degit daggerok/SPDR#main ./12345 && cd $_
bunx serve . -p 1234
open http://0:1234
```

The published application is available at <https://daggerok.github.io/SPDR/>.

### Column types and filters

Every column of the ETF catalog and of the Watchlist, Holdings, History and Distributions tabs has a type: text (`ABC`), number (`123`), percentage (`%`), money (`$`), date (`D`), date and time (`DT`) or time of day (`T`). The type is detected from the texts the column shows (80% of the filled cells must agree, otherwise text) and is written in the badge next to the column title: click it to cycle the type, Shift+click to return to auto-detection. Dates are read as `2024-06-15`, `6/15/2024`, `15.06.2024`, `Jun 15, 2024` or `15-Jun-2024`, date and time as `2024-06-15T09:30:00Z` or `2024-06-15 09:30`, time as `09:30`, `16:00:00` or `9:30 PM`

A row of filter inputs sits under the column headers (the `Filters` button hides it, `Clear filters` empties it). Filters of different columns are combined with AND, the search box applies on top, and Copy Tickers and the exports use the filtered rows. Filters and type overrides are remembered in the browser

Inside one filter: a space means AND, a comma means OR, a leading `!` means NOT, `?` matches an empty or unavailable value and `!?` a value that is there; a value that is unavailable matches only `?` and negated conditions. An unquoted space ends the value, so quote values that contain one (`>="2024-06-15 09:30"`)

| Type | Examples |
| --- | --- |
| Text | `bank` contains, `"two words"`, `!bank`, `=exact`, `^starts`, `ends$`, `/regex/`, `tech, health` |
| Number, percentage, money | `>10`, `>=10 <50`, `=22` (matches what rounds to 22), `!=22`, `10..50`, `..50`, `10..`, `>1B` and `K` `M` `B` `T` suffixes, an optional `$` or `%` |
| Date, date and time | `>2024-06-01`, `2024` (the whole year), `2024-06` (the whole month), `2024-01..2024-06`, `today`, `yesterday`, `-7d..` (the last 7 days), `+2w`, `-3m`, `-1y` |
| Time | `>09:30`, `09:30..16:00`, `=12:00` (the whole minute) |

## Updating the static SPDR data

Run the updater with Bun:

```bash
bun scripts/update-data.ts
```

Run `bun scripts/update-data.ts --help` to print every control with its default and usage examples.

Defaults live in `scripts/update-data.config.json`, one string value per control. Precedence, lowest to highest: file defaults < `advanced` JSON < nonblank workflow inputs < environment variables (locally) or the protected Actions variable (CI). Blank workflow inputs inherit the file value, and `advanced` can set a control to an empty string on purpose. An explicitly set environment variable wins even when empty, and the legacy `SPDR_<NAME>` aliases still work. The **Update SPDR ETF data** workflow runs weekly (Sunday 00:00 UTC) with the file defaults, and manual runs can override them through individual inputs or one `advanced` JSON object such as `{"CONCURRENCY":"1","VERBOSE":"true"}`. CLI and workflow share the same `resolveControls` validation, and the workflow only writes to `api/spdr`. All supplied filters use **AND** logic.

### Data sources

| Block | Source |
| --- | --- |
| Catalog (all US SPDR ETFs) | `https://www.ssga.com/us/en/intermediary/etfs/fund-finder` (SSGA fund finder JSON) |
| Holdings per fund | `https://www.ssga.com/us/en/intermediary/etfs/library-content/products/fund-data/etfs/us/holdings-daily-us-{TICKER}.xlsx` (per-fund holdings XLSX) |
| Daily history, distributions | `https://www.ssga.com/us/en/intermediary/etfs/library-content/products/fund-data/etfs/us/navhistory-daily-us-{TICKER}.xlsx` (NAV history XLSX) |
| Daily Premium/Discount history | `ssga.com/library-content/products/fund-data/etfs/us/pdhist-us-en-{TICKER}.xlsx` |
| ISIN, CUSIP, official 30-Day SEC Yield (subsidized/unsubsidized), official Fund Dividend Yield (whole lineup, one fetch per run) | `ssga.com/library-content/products/fund-data/etfs/us/spdr-product-data-us-en.xlsx` |
| Fallback | Previously published `api/spdr/index.json` |

### Metrics and caveats

Each fund carries a derived `metrics` object that powers the catalog columns shared with the sibling sites:

- `ytd` / `tr1y` - official YTD and 1-year returns -> *YTD Return*, *TR 1Y*
- `cagr3y` / `cagr5y` / `cagr10y` - published annualized 3Y/5Y/10Y figures -> *CAGR 3Y/5Y/10Y*
- `tr3y` / `tr5y` / `tr10y` - cumulative 3Y/5Y/10Y figures `(1 + CAGR)^n - 1` -> *TR 3Y/5Y/10Y*
- `siAnn` - since-inception annualized -> *SI Ann.*; `null` for funds with less than one year of history at the performance date
- `dividendYield` - official SSGA Fund Dividend Yield, else an indicated yield (latest distribution x payments per year / price; semi-annual = 2), an estimate derived from SSGA data. HECO, XITK and XSW publish an official `0.00%`, which is kept as `0` (a real zero, not a missing value)
- `secYield` - official 30-day SEC yield when published; unavailable otherwise, never `0`
- `returnsBasis` - always a non-empty label of how the returns are computed: official SSGA month-end NAV total returns, with `tr3y`/`tr5y`/`tr10y` derived from the official annualized figures; no Yahoo or market-price estimates
- `performanceAsOf` - ISO `YYYY-MM-DD` date of SSGA's month-end performance table the returns are as of (not the NAV date); `null` when SSGA publishes no performance yet (very young funds)

`returnsBasis` and `performanceAsOf` are always the last two keys of `metrics`. Funds launched within the last few months (for example MYCP, MYHF, MYML, QNDX, UCBG) have `performanceAsOf: null` because SSGA has not published a performance table for them yet.

Expense ratio: `terValue` / `ter` are the NET expense ratio (after waivers; the single published figure when there is no waiver), `terGrossValue` / `terGross` the gross ratio. Both come from the product-data workbook ("Gross Expense Ratio", "Net Expense Ratio"), with the fund finder expense ratio as the gross fallback. The `TER` filter uses the net value.

Sources and scope: SPDR has no Yahoo Finance and no SEC EDGAR source. Everything comes from SSGA's own files, so there is no `SKIP_YAHOO`, `EDGAR_FALLBACK` or `SEC_UA` control. Yields are the official 30-day SEC yield and Fund Dividend Yield from SSGA's product-data workbook.

Commodity trusts such as GLD and GLDM hold metal and publish no holdings workbook. That is valid: they get `meta.json`, NAV, returns and history, with holdings `status: "empty"` (`holdingsStatus` in `index.json`). A fund that published holdings before is never emptied by a transient 404.

Consistency: each fund is fetched and computed completely in memory, then written once (pages, then `meta.json`, then stale pages are removed; every JSON file is written through a temp file and renamed). If any required file of a fund fails to download, that fund keeps its previous `meta.json`, pages and `index.json` row together, so the workflow never publishes a new return next to stale files. A fund without `funds/<T>/meta.json` has `dataFile: null` in `index.json`. A rerun with identical upstream data changes nothing, and `generatedAt` moves only when content moved. Newly discovered funds are announced as `NEW FUNDS: A, B` in the run output and in the job summary. Every request times out after 45 s (headers and body) and is retried per `MAX_RETRIES`; the run stops starting new funds after 25 minutes and still writes the index; it exits non-zero when every selected fund failed.

Returns come from SSGA's own NAV series: `PERFORMANCE_*` filters use month-end NAV returns and `TOTAL_RETURN_*` filters use the separate quarter-end series (3Y/5Y/10Y are annualized CAGR). `DIVIDEND_YIELD` and `SEC_YIELD` filters use the same `metrics` values. There are no market-price or Yahoo estimates in this feed, and no ticker exclusions. Funds not selected for a successful update keep their prior published metadata and data files. `TICKERS` combines with the other filters using AND logic; it does not override them.

### Update controls

Every control is in `scripts/update-data.config.json`; the table shows the shipped defaults.

| Control | Default | Meaning |
| --- | --: | --- |
| `MAX_FETCHES` | `0` | Batch size: with a positive value the updater continues after the committed cursor in `api/spdr/update-state.json` (funds passing every filter only, wrapping around; a cursor saved under other filters is ignored and a `TICKERS` run never writes it); `0` is a full pass, every fund is refreshed in one run |
| `REQUEST_SLEEP` | `1` | Minimum delay in seconds between outgoing request starts, including retries |
| `CONCURRENCY` | `2` | Number of parallel fund update workers; request starts are still spaced by `REQUEST_SLEEP` |
| `AUM` | `:` | Net Assets range; each bound may be a USD amount, a `K`/`M`/`B`/`T` amount, or one of `nano`, `micro`, `small`, `mid`, `large` |
| `TER` | `:` | Net expense ratio range in % (strict `min:max`; gross when no waiver is published) |
| `DIVIDEND_YIELD` | `:` | Dividend yield range in % (strict `min:max`); official Fund Dividend Yield, else the indicated yield from the latest distribution; funds without a value fail a bounded range |
| `SEC_YIELD` | `:` | Official 30-day SEC yield range in % (strict `min:max`); funds without a published value fail a bounded range |
| `TICKERS` | empty (all) | Space-, comma- or semicolon-separated ticker allowlist, e.g. `SPY SPYG SPYD SDY XLK`; a ticker that is not in the SPDR catalog is an error |
| `HOLDINGS_PAGE_SIZE` | `250` | Rows in each generated current-holdings JSON page |
| `HISTORY_PAGE_SIZE` | `1000` | Rows in each generated daily-history JSON page |
| `HISTORY_RANGE` | `max` | Window for the generated NAV and premium/discount history: `max`, `Ny` or `Nmo` counted back from the newest row (for example `5y`, `18mo`); SSGA serves the full workbook, so the window trims the generated pages, not the download; older rows already published are kept, a shorter window never deletes history |
| `STORE_RAW_DOWNLOADS` | `false` | Keep the latest source XLSX files under `api/spdr/raw` |
| `MAX_RETRIES` | `2` | Retries after the initial request, integer >= 1; network errors, 45 s timeouts and HTTP 408/425/429/5xx are retried with exponential backoff |
| `VERBOSE` | `false` | Print per-fund retry and fallback notices |
| `USE_SYSTEM_CA` | `auto` | TLS trust store: `auto` restarts the updater once with Bun's `--use-system-ca` when a request fails with an untrusted-certificate error; `true` always uses the system CA store; `false` never restarts. Not an individual workflow input: use `advanced`, the config file or the CLI environment. |
| `PERFORMANCE_YTD` / `_1Y` / `_3Y` / `_5Y` / `_10Y` | `:` | Month-end NAV return range in %; 3Y/5Y/10Y are CAGR; the colon is required (`5:`, `:20`, `5:20`) |
| `TOTAL_RETURN_YTD` / `_1Y` / `_3Y` / `_5Y` / `_10Y` | `:` | Quarter-end NAV return range in %, same syntax |

### Examples

```bash
MAX_FETCHES=10 bun scripts/update-data.ts
TICKERS="SPY SPYG SPYD SDY XLK" bun scripts/update-data.ts
AUM="1B:" TER=":0.5" bun scripts/update-data.ts
DIVIDEND_YIELD="3:" SEC_YIELD="2:" bun scripts/update-data.ts
HISTORY_RANGE=5y bun scripts/update-data.ts
PERFORMANCE_1Y="15:" bun scripts/update-data.ts
```

## TypeScript and verification

The browser app is intentionally build-free: `index.html` carries the markup, styles and bootstrap, and `app.tsx` is TypeScript compiled in the browser with Babel standalone - no build step, no bundler, no `tsconfig.json` needed. Bun runs TypeScript out of the box.

Verification before every publish:

```bash
bun install --frozen-lockfile
bun test
bun build --target=bun scripts/update-data.ts --outfile=/dev/null
git diff --check
```

`bun test` also checks that the config file, `CONTROL_NAMES`, `--help`, this controls table, the README structure and the workflow inputs stay in sync.

## Brands table

| Brand | Where to get the data |
| --- | --- |
| **AAM** | [aamlive.com](https://www.aamlive.com/ETF) \| [AAM](https://daggerok.github.io/AAM/) |
| **abrdn (Aberdeen)** | [aberdeeninvestments.com](https://www.aberdeeninvestments.com/en-us/investor/funds/etfs) \| [aberdeen](https://daggerok.github.io/aberdeen/) |
| **Amplify** | [amplifyetfs.com](https://amplifyetfs.com/) \| [Amplify](https://daggerok.github.io/Amplify/) |
| **ARK Invest** | [ark-funds.com](https://www.ark-funds.com/our-etfs/) \| [ARK](https://daggerok.github.io/ARK/) |
| **Capital Group** | [capitalgroup.com](https://www.capitalgroup.com/advisor/investments/exchange-traded-funds.html) \| [Capital-Group](https://daggerok.github.io/Capital-Group/) |
| **Fidelity** | [fidelity.com](https://www.fidelity.com/etfs) \| [Fidelity](https://daggerok.github.io/Fidelity/) |
| **First Trust** | [ftportfolios.com](https://www.ftportfolios.com/Retail/etf/etflist.aspx) \| [First-Trust](https://daggerok.github.io/First-Trust/) |
| **Franklin Templeton** | [franklintempleton.com](https://www.franklintempleton.com/investments/options/exchange-traded-funds) \| [Franklin](https://daggerok.github.io/Franklin/) |
| **Global X** | [globalxetfs.com/explore](https://www.globalxetfs.com/explore) \| [Global-X](https://daggerok.github.io/Global-X/) |
| **Goldman Sachs** | [am.gs.com](https://am.gs.com/en-us/individual/funds?locale=en-us&audience=individual&sf=funds&filters=funds%7CETF&limit=100) \| [Goldman-Sachs](https://daggerok.github.io/Goldman-Sachs/) |
| **Invesco** | [invesco.com](https://www.invesco.com/us/en/financial-products/etfs.html) \| [Invesco](https://daggerok.github.io/Invesco/) |
| **iShares** | [ishares.com](https://www.ishares.com/) \| [iShares](https://daggerok.github.io/iShares/) |
| **JPMorgan** | [am.jpmorgan.com](https://am.jpmorgan.com/us/en/asset-management/adv/products/fund-explorer/etf) \| [JPMorgan](https://daggerok.github.io/JPMorgan/) |
| **NEOS** | [neosfunds.com](https://neosfunds.com/#explore-etfs) \| [Neos](https://daggerok.github.io/Neos/) |
| **Northern Trust** | [etfs.ntam.northerntrust.com](https://etfs.ntam.northerntrust.com/us/en/individual/funds) \| [Northern-Trust](https://daggerok.github.io/Northern-Trust/) |
| **Pacer ETFs** | [paceretfs.com](https://www.paceretfs.com/products/) \| [Pacer](https://daggerok.github.io/Pacer/) |
| **Parametric** | [eatonvance.com](https://www.eatonvance.com/products/etfs.html) \| [Parametric](https://daggerok.github.io/Parametric/) |
| **ProShares** | [proshares.com](https://www.proshares.com/our-etfs/find-proshares-etfs) \| [ProShares](https://daggerok.github.io/ProShares/) |
| **Schwab** | [schwabassetmanagement.com](https://www.schwabassetmanagement.com/products) \| [Schwab](https://daggerok.github.io/Schwab/) |
| **SP Funds** | [sp-funds.com](https://www.sp-funds.com/) \| [SP-Funds](https://daggerok.github.io/SP-Funds/) |
| **SPDR** | [ssga.com](https://www.ssga.com/us/en/intermediary/etfs/fund-finder) \| [SPDR](https://daggerok.github.io/SPDR/) |
| **Sprott ETFs** | [sprottetfs.com](https://sprottetfs.com/) \| [Sprott](https://daggerok.github.io/Sprott/) |
| **Tema ETFs** | [temaetfs.com](https://temaetfs.com/funds) \| [Tema](https://daggerok.github.io/Tema/) |
| **Themes ETFs** | [themesetfs.com/etfs](https://themesetfs.com/etfs) \| [Themes](https://daggerok.github.io/Themes/) |
| **VanEck** | [vaneck.com](https://www.vaneck.com/us/en/etf-mutual-fund-finder/) \| [VanEck](https://daggerok.github.io/VanEck/) |
| **Vanguard** | [investor.vanguard.com](https://investor.vanguard.com/etf/list) \| [Vanguard](https://daggerok.github.io/Vanguard/) |
| **VictoryShares** | [vcm.com VictoryShares ETFs](https://www.vcm.com/products/victoryshares-etfs/victoryshares-etfs-list) \| [VictoryShares](https://daggerok.github.io/VictoryShares/) |
| **WisdomTree** | [wisdomtree.com](https://www.wisdomtree.com/investments) \| [WisdomTree](https://daggerok.github.io/WisdomTree/) |
| **Xtrackers** | [etf.dws.com](https://etf.dws.com/en-us/etf-products/) \| [Xtrackers](https://daggerok.github.io/Xtrackers/) |

## Sibling applications

| Application | Data provider | Repository |
| --- | --- | --- |
| AAM | Official AAM catalog/detail HTML + full holdings XLS + SEC N-PORT holdings fallback + Yahoo market history/dividends | [AAM](https://github.com/daggerok/AAM) |
| abrdn (Aberdeen) | Official Aberdeen gateway + SEC N-PORT holdings fallback + Yahoo history/dividends | [aberdeen](https://github.com/daggerok/aberdeen) |
| Amplify | Amplify ETFs Firestore data feed + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance history/dividends | [Amplify](https://github.com/daggerok/Amplify) |
| ARK Invest | ark-funds.com fund pages + overview/NAV-history/performance JSON + official daily holdings CSV + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance distributions/history fallback | [ARK](https://github.com/daggerok/ARK) |
| Capital Group | Official Capital Group fund data + SEC N-PORT holdings fallback + Yahoo history fallback | [Capital-Group](https://github.com/daggerok/Capital-Group) |
| Fidelity | SEC EDGAR N-PORT-P + Yahoo Finance | [Fidelity](https://github.com/daggerok/Fidelity) |
| First Trust | ftportfolios.com official ETF list + fund summary, holdings, distribution and price-history export pages + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance history fallback | [First-Trust](https://github.com/daggerok/First-Trust) |
| Franklin Templeton | franklintempleton.com ETF listings + product pages + SEC EDGAR N-PORT-P | [Franklin](https://github.com/daggerok/Franklin) |
| Global X | globalxetfs.com Next.js catalog and fund pages + dated full-holdings CSV | [Global-X](https://github.com/daggerok/Global-X) |
| Goldman Sachs | am.gs.com fund finder + detail pages + SEC EDGAR N-PORT-P | [Goldman-Sachs](https://github.com/daggerok/Goldman-Sachs) |
| Invesco | invesco.com fund pages and sitemap + official Invesco fund API (monthly returns, NAV, AUM, yields, daily holdings, expense ratio) + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance history/dividends | [Invesco](https://github.com/daggerok/Invesco) |
| iShares | iShares (BlackRock) product workbooks | [iShares](https://github.com/daggerok/iShares) |
| JPMorgan | am.jpmorgan.com fund explorer + product-data JSON | [JPMorgan](https://github.com/daggerok/JPMorgan) |
| NEOS | neosfunds.com lineup table + official fund pages + daily holdings CSV | [Neos](https://github.com/daggerok/Neos) |
| Northern Trust | etfs.ntam.northerntrust.com funds list + per-fund CSV/JSON downloads | [Northern-Trust](https://github.com/daggerok/Northern-Trust) |
| Pacer ETFs | paceretfs.com product catalog and fund pages (Cloudflare WAF; r.jina.ai proxy fallback) + SEC EDGAR N-PORT-P (Pacer Funds Trust) + Yahoo Finance history/dividends | [Pacer](https://github.com/daggerok/Pacer) |
| Parametric | eatonvance.com ETF catalog and Parametric product pages + SEC EDGAR N-PORT-P holdings + Yahoo Finance history/dividends | [Parametric](https://github.com/daggerok/Parametric) |
| ProShares | proshares.com ETF finder + fund pages + official data host | [ProShares](https://github.com/daggerok/ProShares) |
| Schwab | schwabassetmanagement.com product pages + CSV exports | [Schwab](https://github.com/daggerok/Schwab) |
| SP Funds | sp-funds.com homepage catalog, fund pages and daily holdings CSV + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance history/dividends | [SP-Funds](https://github.com/daggerok/SP-Funds) |
| SPDR | SSGA / State Street public feeds | [SPDR](https://github.com/daggerok/SPDR) |
| Sprott ETFs | sprottetfs.com fund pages + SEC EDGAR N-PORT-P (Sprott Funds Trust) + Yahoo Finance history/dividends | [Sprott](https://github.com/daggerok/Sprott) |
| Tema ETFs | Tema official fund pages + dated daily holdings CSV; SEC EDGAR N-PORT-P holdings fallback only + Yahoo Finance price/history/dividend fallback | [Tema](https://github.com/daggerok/Tema) |
| Themes ETFs | themesetfs.com catalog + daily holdings CSV + Yahoo Finance history/dividends + SEC N-PORT-P holdings fallback | [Themes](https://github.com/daggerok/Themes) |
| VanEck | vaneck.com ETF finder + product pages | [VanEck](https://github.com/daggerok/VanEck) |
| Vanguard | Vanguard product pages + SEC EDGAR N-PORT-P | [Vanguard](https://github.com/daggerok/Vanguard) |
| VictoryShares | VCM VictoryShares catalog and product JSON + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance adjusted-market-price history | [VictoryShares](https://github.com/daggerok/VictoryShares) |
| WisdomTree | WisdomTree product table + SEC EDGAR N-PORT-P + Yahoo Finance | [WisdomTree](https://github.com/daggerok/WisdomTree) |
| Xtrackers | Official DWS catalog/US sitemap + PDP/XLSX + SEC N-PORT-P holdings fallback + Yahoo Finance daily prices/history/dividends | [Xtrackers](https://github.com/daggerok/Xtrackers) |

## License

[MIT - same as all sibling ETF repositories.](./LICENSE)

SPDR® is a registered trademark of Standard & Poor's Financial Services LLC (S&P), licensed to S&P Dow Jones Indices LLC and sublicensed for certain purposes by State Street Global Advisors; State Street® is a trademark of State Street Corporation. The fund names/tickers referenced here are trademarks of their respective owners. This is an independent, unofficial tool; it is not affiliated with, endorsed by, or sponsored by State Street Global Advisors, State Street Corporation or S&P. All data is reproduced from SSGA's own public downloads for research purposes. All other trademarks, including index names, are the property of their respective owners.
