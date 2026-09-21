# SPDR

SPDR ETF holdings to Watchlist. A single-file client-side tool that reads the generated `./api/spdr` static feed (SSGA daily holdings XLSX, NAV history XLSX, distributions) into a searchable ETF/asset-class catalog with per-fund tabs, watchlist aggregation, ticker copy and CSV/TXT export — the same look, feel, columns and business logic as the sibling applications.

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
bun test scripts/update-data.test.ts
./scripts/update-data.ts
```

Run `./scripts/update-data.ts -h` (or `--help`) to print every configuration variable with its default and usage examples.

The **Update SPDR ETF data** GitHub Actions workflow exposes the same settings as manual inputs. All supplied filters use **AND** logic.

### Data sources

| Block | Source |
| --- | --- |
| Catalog (all US SPDR ETFs) | `https://www.ssga.com/us/en/intermediary/etfs/fund-finder` (SSGA fund finder JSON) |
| Holdings per fund | `https://www.ssga.com/us/en/intermediary/etfs/library-content/products/fund-data/etfs/us/holdings-daily-us-{TICKER}.xlsx` (per-fund holdings XLSX) |
| Daily history, distributions | `https://www.ssga.com/us/en/intermediary/etfs/library-content/products/fund-data/etfs/us/navhistory-daily-us-{TICKER}.xlsx` (NAV history XLSX) |
| Fallback | Previously published `api/spdr/index.json` |

Each fund carries a derived `metrics` object that powers the catalog columns shared with the sibling sites:

- `ytd` / `tr1y` — official YTD and 1-year returns → *YTD Return*, *TR 1Y*
- `cagr3y` / `cagr5y` / `cagr10y` — published annualized 3Y/5Y/10Y figures → *CAGR 3Y/5Y/10Y*
- `tr3y` / `tr5y` / `tr10y` — cumulative 3Y/5Y/10Y figures `(1 + CAGR)^n - 1` → *TR 3Y/5Y/10Y*
- `siAnn` — since-inception annualized → *SI Ann.*
- `dividendYield` — 12-month trailing yield or indicated yield (latest distribution × frequency ÷ price)
- `secYield` — 30-day SEC yield when published; `—` otherwise

### Update controls

| Environment variable | Default | Meaning |
| --- | --: | --- |
| `MAX_FETCHES` | all | Batch size: with a positive value the updater continues after the committed cursor in `api/spdr/update-state.json`; empty or `0` is a full pass — every fund is refreshed in one run. |
| `REQUEST_SLEEP` | `1` | Minimum delay in seconds between outgoing request starts, including retries. |
| `CONCURRENCY` | `2` | Number of parallel fund update workers. Request starts are still globally spaced by `REQUEST_SLEEP`. |
| `AUM` | `:` | Net Assets range. Each bound may be a USD amount or `K`/`M`/`B`/`T`, or one of `nano`, `micro`, `small`, `mid`, `large`. |
| `TER` | `:` | Expense ratio range in % (strict `min:max`). |
| `DIVIDEND_YIELD` | `:` | Dividend-yield percentage range. |
| `TICKERS` | all | Space-, comma- or semicolon-separated ticker allowlist, e.g. `SPY SPYG SPYD SDY XLK`. |
| `HOLDINGS_PAGE_SIZE` | `250` | Rows in each generated current-holdings JSON page. |
| `HISTORY_PAGE_SIZE` | `1000` | Rows in each generated daily-history JSON page. |
| `MAX_RETRIES` | `2` | Retries after the initial request. Only network errors and HTTP 408/425/429/5xx are retried with exponential backoff. |
| `SEC_UA` | declared UA | Override the SEC User-Agent. SEC policy requires automated tools to declare a contact. |
| `SKIP_YAHOO` | off | Skip Yahoo Finance history updates. |

`TICKERS` combines with AUM, TER, yield filters using AND logic; it does not override them. Funds not selected for a successful update keep their prior published metadata and data files.

### Examples

```bash
MAX_FETCHES=10 ./scripts/update-data.ts
TICKERS="SPY SPYG SPYD SDY XLK" ./scripts/update-data.ts
AUM="1B:" TER=":0.5" ./scripts/update-data.ts
PERFORMANCE_1Y="15:" ./scripts/update-data.ts
```

## TypeScript

The browser app is intentionally build-free: `index.html` carries the markup, styles and bootstrap, and `app.tsx` is TypeScript compiled in the browser with Babel standalone — no build step, no bundler, no `tsconfig.json` needed. Bun runs TypeScript out of the box.

Verification before every publish: `bun install --frozen-lockfile`, `bun test`, and `git diff --check`.

## Brands table

| Бренд | Фонды | Где брать данные |
| --- | --- | --- |
| **VanEck** (91) | GDX, SMH, MOAT, ESPO, ANGL, OIH, REMX | [vaneck.com ETF finder](https://www.vaneck.com/us/en/etf-mutual-fund-finder/) — [daggerok/VanEck](https://github.com/daggerok/VanEck) |
| **JPMorgan** (78) | JEPI, JEPQ, JPST, BBJP, JIRE, JGLO | [am.jpmorgan.com ETF explorer](https://am.jpmorgan.com/us/en/asset-management/adv/products/fund-explorer/etf) — [daggerok/JPMorgan](https://github.com/daggerok/JPMorgan) |
| **Schwab** (30+) | SCHB, SCHX, SCHG, SCHV, SCHD, SCHM | [schwabassetmanagement.com](https://www.schwabassetmanagement.com/products) — [daggerok/Schwab](https://github.com/daggerok/Schwab) |
| **Invesco** (245) | QQQM, RSP, SPLV, SPHD, SPMO, QQQ | [invesco.com ETFs](https://www.invesco.com/us/en/financial-products/etfs.html) — [daggerok/Invesco](https://github.com/daggerok/Invesco) |
| **iShares** (400+) | IVV, SGOV, DGRO, SOXX, IWM, EFA | [ishares.com](https://www.ishares.com/) — [daggerok/iShares](https://github.com/daggerok/iShares) |
| **Fidelity** (70+) | FTEC, FDVV, FDIS, FCOM, FREL | [fidelity.com/etfs](https://www.fidelity.com/etfs) — [daggerok/Fidelity](https://github.com/daggerok/Fidelity) |
| **Amplify** (20+) | DIVO, IDVO, SILJ, BLOK, IBUY | [amplifyetfs.com](https://amplifyetfs.com/) — [daggerok/Amplify](https://github.com/daggerok/Amplify) |
| **Vanguard** (80+) | VTI, VOO, BND, VUG, VTV, VXUS | [investor.vanguard.com](https://investor.vanguard.com/etf/list) — [daggerok/Vanguard](https://github.com/daggerok/Vanguard) |
| **SPDR** (179) | SPY, SPYM, SPYG, XLK, XLF, XLV | [ssga.com fund finder](https://www.ssga.com/us/en/intermediary/etfs/fund-finder) — [daggerok/SPDR](https://github.com/daggerok/SPDR) |
| **WisdomTree** (90+) | DGRW, USFR, WCLD, DGRW, EFS | [wisdomtree.com](https://www.wisdomtree.com/investments) — [daggerok/WisdomTree](https://github.com/daggerok/WisdomTree) |
| **Goldman Sachs** (48) | GSLC, GBIL, AAAU, GPIX, GPIQ, GSST | [am.gs.com fund finder](https://am.gs.com/en-us/individual/funds?locale=en-us&audience=individual&sf=funds&filters=funds%7CETF&limit=100) — [daggerok/Goldman-Sachs](https://github.com/daggerok/Goldman-Sachs) |

## Sibling applications

| Application | Data provider | Repository |
| --- | --- | --- |
| Amplify ETF Holdings to Watchlist | Amplify ETFs (Firestore data feed) | [daggerok/Amplify](https://github.com/daggerok/Amplify) · [published app](https://daggerok.github.io/Amplify/) |
| iShares ETF Holdings to Watchlist | iShares (BlackRock) product workbooks | [daggerok/iShares](https://github.com/daggerok/iShares) · [published app](https://daggerok.github.io/iShares/) |
| SPDR ETF Holdings to Watchlist | SSGA / State Street public feeds | [daggerok/SPDR](https://github.com/daggerok/SPDR) · [published app](https://daggerok.github.io/SPDR/) |
| Fidelity ETF Holdings to Watchlist | SEC EDGAR N-PORT-P + Yahoo Finance | [daggerok/Fidelity](https://github.com/daggerok/Fidelity) · [published app](https://daggerok.github.io/Fidelity/) |
| Invesco ETF Holdings to Watchlist | invesco.com CSV downloads + Yahoo Finance | [daggerok/Invesco](https://github.com/daggerok/Invesco) · [published app](https://daggerok.github.io/Invesco/) |
| WisdomTree ETF Holdings to Watchlist | WisdomTree product table + SEC EDGAR N-PORT-P + Yahoo Finance | [daggerok/WisdomTree](https://github.com/daggerok/WisdomTree) · [published app](https://daggerok.github.io/WisdomTree/) |
| JPMorgan ETF Holdings to Watchlist | am.jpmorgan.com fund explorer + product-data JSON | [daggerok/JPMorgan](https://github.com/daggerok/JPMorgan) · [published app](https://daggerok.github.io/JPMorgan/) |
| VanEck ETF Holdings to Watchlist | vaneck.com ETF finder + product pages | [daggerok/VanEck](https://github.com/daggerok/VanEck) · [published app](https://daggerok.github.io/VanEck/) |
| Schwab ETF Holdings to Watchlist | schwabassetmanagement.com product pages + CSV exports | [daggerok/Schwab](https://github.com/daggerok/Schwab) · [published app](https://daggerok.github.io/Schwab/) |
| Vanguard ETF Holdings to Watchlist | Vanguard product pages + SEC EDGAR N-PORT-P | [daggerok/Vanguard](https://github.com/daggerok/Vanguard) · [published app](https://daggerok.github.io/Vanguard/) |
| Goldman Sachs ETF Holdings to Watchlist | am.gs.com fund finder + detail pages + SEC EDGAR N-PORT-P | [daggerok/Goldman-Sachs](https://github.com/daggerok/Goldman-Sachs) · [published app](https://daggerok.github.io/Goldman-Sachs/) |

## License

[MIT — same as all sibling ETF repositories.](./LICENSE)
