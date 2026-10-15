# TCG Refurb Shop
Version 2.5.0 — 14 October 2026

## Run

```sh
npm start
```

Open http://localhost:3000. This app has no npm dependencies. The existing passcode and environment settings are unchanged.

## Update an existing installation

Upload the extracted files to the repository root and restart/redeploy the app. Keep the existing persistent volume, `DATA_DIR`, `AUTH_SECRET` and `REFURB_PASSCODE`. **Do not delete or replace your live `data.json`.** This package does not contain one.

Close old browser tabs and refresh after restarting. The server rejects saves from a tab that has not loaded the new order revision.

On first startup, open scanner orders previously supplied by this app for SBX-002, SBX-008, SBX-018 and SBX-029 receive the corrected requirements **in place**. Their identifiers and order numbers are retained. No duplicate scanner order is added. Closed orders and unrelated manually created orders are left alone.

The previous data file is backed up in `DATA_DIR/.refurb-backups/` before migration. Previous order parts and print-request snapshots are also kept in each order's `scopeHistory`. This is a one-time correction; later edits and deletions survive restarts.

## Current requirements

- Bulk fasteners and housing hardware are deferred. FAS0181 x2 is the explicit exception for the positioning shafts. Inventory catalog entries are retained for later use.
- Scanner bearings remain in the replacement parts: OTS0037 x23 and OTS0046 x2 per scanner, using the previously accepted bearing counts.
- OTS0063 x2 covers the M1/M2 replacement motors. SA006/SA092 are not extra picks.
- Each order includes SA098 x2 in Assembly references. Each SA098 has MFG0478 x1, MFG0479 x1 and MFG0480 x2, per Craig's final correction. OTS0119 foam remains 100 mm per assembly from the submitted BOM, therefore 200 mm for two assemblies.
- OTS0200 x3 clear positioning belts, MFG0481 x2 screw caps and FAS0181 x2 socket-head screws are separate order quantities, not per-assembly quantities.
- Components appear once in Required parts. Assembly references do not create duplicate parent demand.
- CAB0024 is included once through SA080-OBS. Cable subassembly raw materials and printed-part filament are not additional item picks.
- 3D-print requests contain only the explicitly requested printed parts and printable components of the supplied individual BOMs. Shafts, boards, acrylic diffuser panels, bearings, fasteners, cable assemblies and molded MFG0322 are not printable items.
- Extra full-scanner housing parts and the top-level MFG0415/MFG0418 diffuser back caps are removed from these orders.
- The kit-number question is not a blocker; the supplied SA048_PR3-OBS BOM defines the PR3 feed-fixer scope.

Existing stock balances and stock-transaction history are not changed by this correction. Removed parts that had already been issued remain in `deferredIssuedHardware` and order history; they are not silently returned to stock. A retained part with more already issued than its new requested quantity keeps its issued amount and a visible note for manual reconciliation.

## Editing

Open **Refurb Jobs → Open order / edit parts**. Required parts have editable quantities, part numbers, descriptions, supply sources and notes. Add or remove parts as needed.

Under **Assembly references**, use **Edit assembly quantity** to change an assembly count. Only that assembly's component-quantity difference is applied; shared components and separately requested belts/caps/screws are not multiplied again. Individual part edits remain authoritative. Stock already issued is protected against an invalid quantity reduction.

After editing print quantities, use **Refresh request**. The stale-request indicator remains visible until refreshed. The corrected requests start as drafts; no printer command or stock deduction is triggered.

## One pending detail

MFG0315-OBS is confirmed as the L bracket, but its per-scanner quantity and the long thumbscrew part number have not been provided. Its Assembly reference is present with the quantity blank. Entering a bracket quantity adds exactly one MFG0315-OBS printed bracket and one FAS0101 plain M6 hex nut per bracket. The long thumbscrew is not guessed. Resolve the pending note after entering the remaining information.

## Files

`ORDER_PARTS.csv`, `PRINT_PARTS.csv` and `ASSEMBLY_REFERENCES.csv` are snapshots of the packaged order requirements. The four `MO-....pdf` files are printable snapshots. After editing, use the app's **Print full order**, **Parts CSV** and print-request exports for current data.

The `BOM--*.pdf` files are the individual source documents. `scanner-bom-library.json` records their component scope; SA098 preserves the PDF values separately from Craig's explicit override. Inventory material/weight fields are reference data, not order quantities or slicer settings.

All files in this distribution are at the ZIP root. No hosted site is changed until the package is deployed.

## Tests

```sh
npm test
```

See `TEST_RESULTS.md`. The app still uses shared whole-state storage; avoid simultaneous edits on multiple devices and keep backups.
