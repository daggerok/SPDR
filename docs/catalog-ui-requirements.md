# Reusable ETF catalog UI requirements

Use this checklist when applying the shared catalog behavior to another provider repository. Keep provider names, feed paths, and the existing visual language provider-specific; the interaction contract below should stay consistent.

## 1. Distribution frequency column

- Read the existing generated distribution-frequency field. For SPDR this is `fund.distributions.frequency` from the SSGA dividend-distribution feed. Do not add a second data source or recompute the cadence in the browser.
- Display the catalog header as **Frequency**.
- Keep the column sortable by storing/displaying a two-digit numeric prefix:
  - `01 - Monthly`
  - `04 - Quarterly`
  - `06 - Semi-annually`
  - `12 - Annually`
- Normalize provider spelling variants such as `Semi-Annual`/`Semi-Annually` and `Annual`/`Annually` to the labels above.
- Use `00 - Unknown`, `00 - None`, or `00 - —` for unavailable/unknown values. Use `99 - Irregular` for irregular distributions. These prefixes keep the normal ascending sort order meaningful.
- Place the catalog column after **SEC Yield** and before **YTD Return** for this layout. If a sibling repository has a different explicit column contract, preserve that repository's requested order while retaining the same labels and codes.
- Keep the CSV and TXT export headers and row values in the same order and format as the visible catalog.
- Add a native header tooltip that states the source feed and explains the numeric codes.
- The detail/distributions view may continue to show the provider's raw frequency label; the coded value is required for the sortable catalog column and exports.

## 2. Horizontally pinned catalog columns

- The catalog table must remain horizontally scrollable inside `#table-scroll`; do not make the page itself the horizontal scroll surface.
- Keep the leading **Use** checkbox and **Ticker** columns visible while the user scrolls to the right. The row-number `#` column should also be pinned as the left anchor so the sticky columns do not overlap the first column at the unscrolled position.
- The pinned order is therefore `#`, `Use`, `Ticker`, followed by the ordinary horizontally scrolling columns.
- Use `position: sticky` with stable left offsets matching the actual column widths. For the standard layout: `# = 3rem`, `Use = 5rem`, and `Ticker` begins at `8rem`.
- Give sticky header cells a higher z-index than sticky body cells. Give all sticky cells opaque light/dark backgrounds so scrolled content cannot show through them.
- Use separated table borders (`border-collapse: separate; border-spacing: 0`) and a stacking context for the scroll table. This prevents long Fund Name text or a hovered row from painting over the pinned cells.
- Keep moving body cells at a lower stacking level than the pinned cells, and avoid transforms on the scrolling `tbody` animation that can create a competing stacking context. Use a separate opacity-only row refresh if an entry animation is needed.
- Preserve hover and selected-row backgrounds on the sticky cells in both themes. Add a subtle right edge/shadow on the Ticker cell to make the pinned boundary clear.
- Checkboxes and the blacklist button in the Use cell must remain clickable after horizontal scrolling. Do not place an overlay above the pinned cells.
- Keep the sticky header and sticky left columns working together when the table is vertically and horizontally scrolled.
- Preserve the existing responsive table behavior, table-height calculation, lazy loading, search, sorting, row selection, and dark theme.

## Acceptance checklist

1. Load the catalog at a narrow desktop/mobile viewport where horizontal scrolling is required.
2. Scroll the catalog fully to the right. The `#`, **Use**, and **Ticker** columns remain visible at the left.
3. Click a Use checkbox and the blacklist button both before and after horizontal scrolling; both actions still work and do not open the row detail accidentally.
4. Select a row and confirm the pinned cells keep the selected-row background; hover a row and confirm the pinned cells keep the hover background.
5. Repeat checks in light and dark themes.
6. Sort **Frequency** ascending and confirm the sequence is `01`, `04`, `06`, `12` (with `00` unavailable values and `99` irregular values handled consistently).
7. Export CSV and TXT and confirm **Frequency** appears after **SEC Yield** and before **YTD Return**, with the same coded values.
8. Confirm the empty-search state spans the new column count and no table content is hidden behind the pinned cells.

## Handoff summary for another agent

> Add the existing distribution frequency to the sortable catalog as `Frequency`, using the codes `01 - Monthly`, `04 - Quarterly`, `06 - Semi-annually`, `12 - Annually`, `00` for unavailable/unknown, and `99` for irregular. Keep the export aligned. Pin the leading `#`, `Use`, and `Ticker` columns inside the horizontal table scroller with opaque theme-aware backgrounds, correct sticky offsets/z-indexes, and working checkbox/blacklist interactions after horizontal scrolling. Validate the acceptance checklist above.
