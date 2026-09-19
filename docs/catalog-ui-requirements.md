# Catalog UI requirements

Reusable catalog presentation rules shared with the sibling ETF applications.

## Coded distribution frequency

The catalog **Frequency** column is a sortable coded cadence, not free text:

| Code | Meaning |
|---|---|
| `01 - Monthly` | Monthly |
| `04 - Quarterly` | Quarterly |
| `06 - Semi-annually` | Semi-annual |
| `12 - Annually` | Annual |
| `00 - —` / `00 - None` / `00 - Unknown` | Missing / unpublished / unknown |
| `99 - Irregular` | Irregular |

SSGA's prose values (`Monthly`, `Quarterly`, …) are mapped through
`formatDividendFrequency` before the row is rendered or sorted, so lexical
sort of the column matches payment cadence.

## Pinned horizontal-scroll columns

`position: sticky` is applied **directly to the `th`/`td`**, never to a nested
wrapper. A sticky child cannot move past its containing block, so pinning a
nested span silently fails the moment that cell scrolls off-screen.

| View | Classes | Pin |
|---|---|---|
| Catalog Use | `#table-scroll .catalog-sticky-col.catalog-sticky-use` | `left: 0` |
| Catalog Ticker | `#table-scroll .catalog-sticky-col.catalog-sticky-ticker` | `left: 5rem` |
| Watchlist Ticker | `#table-scroll .watchlist-sticky-ticker` | `left: 0` |

Pinned cells use opaque, pre-blended backgrounds (not translucent `rgba()`
row tints) so scrolled-behind column text cannot show through. Hover and
selected-row variants keep the same solid fills.
