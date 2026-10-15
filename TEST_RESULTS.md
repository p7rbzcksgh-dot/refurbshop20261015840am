# Verification — TCG Refurb Shop 2.5.0

14 October 2026

## Automated checks

`npm test`: 50 passed, 0 failed, 0 skipped.

Coverage includes:

- Four scanner orders with stable serials and unique order numbers.
- SA098 x2 per order, one front/one back/two hubs per assembly; three separate clear belts, two screw caps and two FAS0181 screws.
- 200 mm foam per order from two 100 mm SA098 BOM allocations.
- Bulk fastener and unrelated housing removal while retaining bearings and the explicitly requested FAS0181 screws.
- Exact print-list membership: no shafts, electronics, acrylic, molded parts, cables, bearings, raw filament or parent assemblies.
- CAB0024 and shared child-component deduplication; valid nested PR3 feed-fixer quantities.
- Assembly-quantity edits by allocation delta, separately requested extras unchanged, and no reductions below issued stock.
- L-bracket/nut additions only after an operator supplies a quantity; no guessed thumbscrew.
- Existing-order migration in place, stock balances and histories preserved, earlier data backed up, stale-browser saves rejected.
- User edits, deleted lines and deleted orders survive restart; renamed inventory numbers remain linked.
- Authentication, private file restrictions and corrupt-data protection.

## Browser interactions

The actual frontend ES modules were rendered in Chromium with a local-only bridge to the running app API. The environment did not permit normal browser navigation to the local server, so the bridge was used for browser interaction tests; ordinary HTTP routes were tested separately by Node.

Verified: order rendering without the removed banner; assembly edit/save; component edit/save; stale print-request indicator; request refresh; correct cap/hub rows and no nonprinted parts on print requests; mobile layout at 390 px with no document-width overflow. No browser page errors.

## Printable snapshots

Four PDFs generated from the app's manufacturing-order HTML. Each is four Letter-size pages. Every current part number was checked against its PDF; removed FAS0119 and MFG0415/MFG0418 are absent. All pages rendered for visual inspection with no clipped table rows or missing part text observed.

## Limits

Tests use isolated local data, not the hosted installation. No live deployment, stock issue, printer command or manufacturing completion was performed. Existing inventory material/weight fields are not slicer measurements.
