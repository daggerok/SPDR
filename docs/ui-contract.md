# ETF Watchlist UI contract

The provider applications share this interaction contract so users do not need to learn a different workflow for each data source.

## Catalog

- Search placeholder: `Search ETFs, fund names, holdings, tickers, CUSIPs, ISINs...`
- Opening the application starts with no funds selected. The user explicitly chooses funds for comparison.
- `All ETFs` and category tabs filter the catalog; they do not change the saved selection.
- Catalog columns use the common order documented in the README and preserve unavailable provider metrics as `—`.

## Selection and watchlist

- Selection is persisted per provider in `localStorage`.
- `Select all` applies to the visible, non-blacklisted catalog.
- The Watchlist tab aggregates holdings across selected funds and exposes the number of selected ETFs holding each security.
- Blacklisting is persisted per provider and removes a fund from the catalog and selection until restored.

## Data states

The UI distinguishes loading, unavailable, and not-applicable values. A provider limitation must be explained in a tooltip or the fund's data-provenance panel; an em dash must not imply that a request is still loading.

Each fund detail view should identify:

- source provider and URL;
- holdings and history as-of dates;
- whether returns are NAV total return or adjusted market-price return;
- whether a yield is trailing, indicated, distribution-derived, or SEC yield;
- known freshness or coverage limitations.

## Detail navigation

Provider-specific data may be unavailable, but the target information architecture is:

`Overview` · `Holdings` · `History` · `Performance` · `Allocations` · `Distributions` · `Yields` · `Price`

When a provider does not publish a dataset, retain the navigation entry and explain the limitation rather than silently changing the product layout.

## Accessibility baseline

Interactive controls should have an accessible name, active tabs should expose `aria-selected`, sortable headers should expose `aria-sort`, and loading/error status changes should be announced to assistive technology. Keyboard focus and reduced-motion preferences must remain visible/respected.
