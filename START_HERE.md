# TCG Refurb Shop — update

1. Extract the ZIP and upload its contents directly to the GitHub repository root.
2. Keep your existing persistent data volume and environment settings. Do not delete or replace `data.json`.
3. Restart/redeploy. Close old tabs and refresh the app.
4. Open **Refurb Jobs**. The existing open scanner jobs are corrected once; they are not duplicated.

## Corrections

Bulk hardware and unrelated full-scanner housing items are removed. Scanner bearings remain. The positioning replacements are **SA098 x2**, **OTS0200 x3**, **MFG0481 x2** and **FAS0181 x2** per scanner. Each SA098 contains one front shaft, one back shaft and two hubs. The supplied BOM's foam requirement is 100 mm per assembly.

Required parts count the components once. Assembly references show the parent quantities without duplicating material demand. Both assembly and component quantities can be edited. Refresh the print request after changing print quantities.

3D-print requests exclude shafts, bearings, electronics, cable assemblies, acrylic panels, molded parts and fasteners. The four PDF sheets and CSVs are starting snapshots; use the app's print/export buttons after edits.

The L bracket **MFG0315-OBS** still needs a quantity and the long thumbscrew's part number. Entering its quantity in Assembly references also adds the confirmed plain M6 nut, one per bracket. No quantity has been guessed.

Read `README.md` for migration safeguards and the included source files. Nothing has been sent to a physical printer or changed in the live hosted installation by downloading this ZIP.
