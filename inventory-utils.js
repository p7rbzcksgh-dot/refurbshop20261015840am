/* Shared inventory rules: browser + server. No bundled data or dependencies. */
export const SUPPORTED_GENS = [1, 2, 3, 4, 5, 6, 7];
export const INVENTORY_CATEGORIES = ['3DP', 'Hardware', 'Assembly', 'OTS', 'MFG', 'Tools', 'Consumable', 'Other'];
export const partKey = value => String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toUpperCase();
const finite = (value, fallback = 0) => value === '' || value == null || !Number.isFinite(Number(value)) ? fallback : Number(value);
const string = value => value == null ? '' : String(value);
const clone = value => structuredClone(value);
export function inferPartGens(value) {
  const text = String(value || '');
  const found = new Set([...text.matchAll(/\bPR\s*(\d+)\b/gi)].map(m => Number(m[1])));
  for (const range of text.matchAll(/\bPR\s*(\d+)\s*(?:[-–—]|to)\s*(?:PR\s*)?(\d+)\b/gi)) {
    const low = Math.min(+range[1], +range[2]), high = Math.max(+range[1], +range[2]);
    for (const gen of SUPPORTED_GENS) if (gen >= low && gen <= high) found.add(gen);
  }
  return SUPPORTED_GENS.filter(gen => found.has(gen));
}
export function categoryFromGroup(group, name = '', pn = '') {
  const code = partKey(group), label = String(name).toLowerCase();
  if (code === '3DP' || label === '3d print') return '3DP';
  if (code === 'FSTN' || label === 'fasteners') return 'Hardware';
  if (['SA', 'SSA', 'INASS', 'MA', 'KIT', 'PB9000', 'AG00041', 'AG00035'].includes(code)) return 'Assembly';
  if (code === 'OTS') return 'OTS';
  if (code === 'MFG') return 'MFG';
  if (['TOOLS', 'AG00024', 'AG00029', 'AG00023', 'AG00033'].includes(code)) return 'Tools';
  if (['AG00017', 'AG00021', 'AG00027', 'AG00031', 'SHIPPING'].includes(code)) return 'Consumable';
  return 'Other';
}
const excludedGroups = new Map([
  ['AG00025', 'Office supplies'], ['AG00022', 'Office furniture / equipment'],
  ['AG00016', 'Clothing / promotional merchandise'], ['AG00014', 'Filament / 3D-printing feedstock'],
  ['AG00019', '3D-printer maintenance'], ['AG00034', 'Marketing materials'],
  ['AG00036', 'Office computer assets'], ['AG00032', 'Software / licences'],
  ['AG00042', 'Subscriptions'], ['AG00043', 'Education / training'],
  ['AG00030', 'Transaction fees'], ['AG00037', 'Meals / entertainment'],
  ['AG00038', 'Certification / compliance services'], ['AG00039', 'Building / washroom cleaning supplies'],
]);
const excludedPartNotes = {
  A00347: 'Unidentified placeholder item', 'AVAILABLE TO USE': 'Availability placeholder, not a part',
  A00277: 'Shipping service', A01513: 'Market-access service',
  A01653: 'Online course', A01654: 'Online course', A01136: 'Bambu P1 printer toolhead cable',
  A00283: 'Asset tracking accessory', A00361: 'Office / kitchen cups',
  A01399: 'Gift / promotional packaging', A01400: 'Gift / promotional packaging',
  A01705: 'Supplier store credit', A02097: 'Building floor coating',
  A01120: 'Vehicle rental', A01121: 'Vehicle fuel',
  A00464: 'Shipping cost', A00655: 'Customs declaration', A00849: 'Duty / tax',
  A00278: 'Postage', A01567: 'Show supplies', A02101: 'Vehicle fuel',
};
export function exclusionReason(row) {
  const pn = partKey(row.pn ?? row['Part No.']);
  const group = partKey(row.groupNumber ?? row['Group number']);
  const desc = string(row.desc ?? row['Part description'] ?? row.Description);
  if (excludedGroups.has(group)) return excludedGroups.get(group);
  if (excludedPartNotes[pn]) return excludedPartNotes[pn];
  // Actual manufactured parts stay, including obsolete revisions and polymer parts.
  if (['3DP', 'FSTN', 'MFG', 'OTS', 'SA', 'MA', 'KIT', 'AG00041', 'AG00035', 'PB9000'].includes(group)) return '';
  if (/\bfilament\b/i.test(desc)) return 'Filament / 3D-printing feedstock';
  if (/\b(post-it|sticky notes|notepads?|stationery|hoodies?|t-shirts?|polo shirts?)\b/i.test(desc)) return 'Office supplies / clothing';
  if (/\b(bambu lab|formlabs|postpro)\b/i.test(desc) || /ELEGOO Saturn.*3D Printer/i.test(desc)) return '3D-printer equipment / accessories';
  if (group === 'AG00024' && /\b(stackable bins?|shelf bin organizer|storage rack|shelving unit|packing table|workbench|work stool|office chairs|tool chest|pegboard|trash can dolly|little red cart|wire cart)\b/i.test(desc)) return 'Furniture / storage fixtures';
  if (/\b(online course|subscription|store credit)\b/i.test(desc)) return 'Non-inventory service / subscription';
  return '';
}
export function normalizeStockPart(part = {}) {
  return {
    ...part,
    pn: string(part.pn).trim(), desc: string(part.desc),
    gens: [...new Set((Array.isArray(part.gens) ? part.gens : []).map(Number))].filter(g => SUPPORTED_GENS.includes(g)).sort((a,b) => a-b),
    wt: part.wt === '' || part.wt == null || !Number.isFinite(Number(part.wt)) ? null : Math.max(0, Number(part.wt)),
    qty: Math.max(0, finite(part.qty, 1)),
    status: part.status === 'OBS' ? 'OBS' : 'Active',
    category: INVENTORY_CATEGORIES.includes(part.category) ? part.category : 'Other',
    onHand: Math.max(0, finite(part.onHand)), minStock: Math.max(0, finite(part.minStock)),
    location: string(part.location), uom: string(part.uom), groupNumber: string(part.groupNumber), groupName: string(part.groupName),
    notes: string(part.notes), revision: string(part.revision), vendor: string(part.vendor), vendorPart: string(part.vendorPart),
    material: string(part.material), finish: string(part.finish), stockSize: string(part.stockSize), partType: string(part.partType),
    url: string(part.url), barcode: string(part.barcode),
    csvFields: part.csvFields && typeof part.csvFields === 'object' && !Array.isArray(part.csvFields) ? Object.fromEntries(Object.entries(part.csvFields).map(([k,v]) => [k,string(v)])) : {},
  };
}
export function partFromCsvRow(row) {
  const get = (...keys) => { for (const key of keys) if (row[key] !== undefined && row[key] !== '') return row[key]; return ''; };
  const pn = get('Part No.', 'Part No', 'pn');
  const desc = get('Part description', 'Description', 'desc');
  const groupNumber = get('Group number', 'Group Number', 'groupNumber');
  const groupName = get('Group name', 'Group Name', 'groupName');
  const fits = get('Fits');
  return normalizeStockPart({
    pn, desc, groupNumber, groupName,
    category: get('Category', 'category') || categoryFromGroup(groupNumber, groupName, pn),
    gens: inferPartGens(fits || pn + ' ' + desc),
    wt: get('Weight g', '3DP Weight', 'Weight', 'wt') || null,
    qty: get('QTY Per Machine', 'Qty per machine', 'qty') || 1,
    status: get('Status', 'status') || (/\bOBS\b/i.test(pn) ? 'OBS' : 'Active'),
    onHand: get('On Hand', 'On hand', 'onHand', 'Quantity', 'In stock') || 0,
    minStock: get('Min Stock', 'Minimum Stock', 'Reorder point', 'minStock') || 0,
    location: get('Location', 'Default storage location', 'location'), uom: get('UoM', 'uom'),
    notes: get('Notes', 'notes'), revision: get('Revision', 'revision'), vendor: get('Vendor name', 'Vendor', 'vendor'),
    vendorPart: get('Vendor part no.', 'Vendor part', 'vendorPart'),
    material: get('Material', 'material'), stockSize: get('Stock Size', 'stockSize'), finish: get('Finish', 'finish'),
    partType: get('Part Type', 'partType'), url: get('URL', 'url'), barcode: get('Barcode UPC-A/EAN-13', 'Barcode', 'barcode'),
    csvFields: row,
  });
}
export function partSearchText(part) {
  return [part.pn, part.desc, part.category, part.groupNumber, part.groupName, part.location, part.vendor,
    part.vendorPart, part.material, part.revision, part.notes, ...(part.previousPartNumbers || []), ...(part.gens || []).map(g => `PR${g}`)].join(' ').normalize('NFKC').toLowerCase();
}
export function matchesPart(part, query) {
  const tokens = String(query || '').normalize('NFKC').toLowerCase().trim().split(/\s+/).filter(Boolean);
  const haystack = partSearchText(part);
  const compactPn = partKey(part.pn).replace(/[\s_\-]/g, '').toLowerCase();
  return tokens.every(token => haystack.includes(token) || (token.replace(/[\s_\-]/g, '').length > 0 && compactPn.includes(token.replace(/[\s_\-]/g, ''))));
}
export function compareParts(a,b) { return a.pn.localeCompare(b.pn, 'en', {numeric:true, sensitivity:'base'}); }
export function partInUse(state, pn) {
  const key = partKey(pn);
  return (state.mos || []).some(mo => [...(mo.parts || []), ...(mo.printRequest?.lines || []), ...(mo.housing || []), ...(mo.bomTasks || []), ...(mo.bomTasks || []).flatMap(t=>t.components||[])].some(line => partKey(line.pn) === key));
}
function remapReferences(state, aliases) {
  const remapLine = line => aliases.has(partKey(line.pn)) ? {...line, pn: aliases.get(partKey(line.pn))} : line;
  return {
    ...state,
    mos: (state.mos || []).map(mo => ({...mo, parts: (mo.parts || []).map(remapLine),
      housing:(mo.housing||[]).map(remapLine),bomGaps:(mo.bomGaps||[]).map(remapLine),
      bomTasks:(mo.bomTasks||[]).map(task=>({...remapLine(task),components:(task.components||[]).map(remapLine)})),
      ...(mo.printRequest ? {printRequest:{...mo.printRequest, lines:(mo.printRequest.lines || []).map(remapLine)}} : {})})),
    inventoryLog: (state.inventoryLog || []).map(remapLine),
  };
}
export function editInventoryPart(state, originalPn, values) {
  const current = state.parts.find(p => p.pn === originalPn);
  if (!current) throw new Error('This part no longer exists. Refresh the inventory.');
  if (!String(values.pn ?? current.pn).trim()) throw new Error('Enter a part number.');
  const next = normalizeStockPart({...current, ...values});
  if (state.parts.some(p => p !== current && partKey(p.pn) === partKey(next.pn))) throw new Error('That part number already exists. Each part number must be unique.');
  for (const key of ['onHand','minStock','qty','wt']) {
    if (values[key] !== '' && values[key] != null && (!Number.isFinite(Number(values[key])) || Number(values[key]) < 0)) throw new Error('Quantities and weights must be zero or greater.');
  }
  if (next.pn !== originalPn) next.previousPartNumbers = [...new Set([...(current.previousPartNumbers || []), originalPn])];
  const renamed = remapReferences(state, new Map([[partKey(originalPn), next.pn]]));
  const delta = next.onHand - Number(current.onHand || 0);
  return {...renamed, parts:state.parts.map(p => p === current ? next : p), inventoryLog:delta ? [
    {id:globalThis.crypto?.randomUUID?.() || `edit-${Date.now()}`, pn:next.pn, delta, reason:'Inventory count edited', mo:'', at:new Date().toISOString()},
    ...renamed.inventoryLog,
  ].slice(0,2000) : renamed.inventoryLog};
}
export function applyInventoryBatch(state, batch, legacyParts = []) {
  if ((state.appliedInventoryBatches || []).includes(batch.id)) return {state, changed:false};
  const legacy = new Map(legacyParts.map(p => [partKey(p.pn), normalizeStockPart({...p, category:p.category || '3DP'})]));
  const byKey = new Map(), aliases = new Map();
  const report = {id:batch.id, importedAt:new Date().toISOString(), added:0, enriched:0, replacedUntouchedSeed:0,
    duplicateExisting:[], removedExcluded:[], retainedReferencedExcluded:[], preservedStock:[]};
  for (const part of state.parts || []) {
    const key = partKey(part.pn);
    if (!key) continue;
    if (byKey.has(key)) { report.duplicateExisting.push(part.pn); continue; }
    byKey.set(key, clone(part)); aliases.set(key, part.pn);
  }
  const excluded = new Map((batch.excluded || []).map(p => [partKey(p.pn), p.reason]));
  for (const [key, part] of byKey) if (excluded.has(key)) {
    if (partInUse(state, part.pn)) { part.exclusionNote = excluded.get(key); report.retainedReferencedExcluded.push(part.pn); }
    else { byKey.delete(key); report.removedExcluded.push(part.pn); }
  }
  for (const incomingRaw of batch.parts) {
    const incoming = clone(incomingRaw), key = partKey(incoming.pn), existing = byKey.get(key);
    if (!existing) { byKey.set(key, incoming); aliases.set(key,incoming.pn); report.added++; continue; }
    const old = legacy.get(key);
    const untouched = old && ['desc','gens','wt','qty','status','category','onHand','minStock','location'].every(field => JSON.stringify(existing[field] ?? old[field]) === JSON.stringify(old[field]));
    const movement = (state.inventoryLog || []).some(e => partKey(e.pn) === key) || (state.mos || []).some(mo => (mo.parts || []).some(line => partKey(line.pn) === key && Number(line.issuedQty) > 0));
    if (untouched && !movement) {
      byKey.set(key, {...existing, ...incoming, pn:existing.pn}); report.replacedUntouchedSeed++;
    } else {
      // Keep live quantities and edits. Fill only metadata that was absent/blank.
      const merged = {...incoming, ...existing, inventoryImportId:batch.id,
        csvFields:{...incoming.csvFields, ...existing.csvFields}, sourceFiles:incoming.sourceFiles,
        importSnapshot:{onHand:incoming.onHand, quantitySource:incoming.quantitySource, date:batch.date}};
      for (const field of ['groupNumber','groupName','uom','vendor','vendorPart','revision','material','finish','stockSize','partType','url','barcode']) {
        if (!existing[field]) merged[field] = incoming[field];
      }
      byKey.set(key, merged); report.enriched++;
      if (Number(existing.onHand || 0) !== incoming.onHand) report.preservedStock.push({pn:existing.pn, live:existing.onHand || 0, csv:incoming.onHand});
    }
  }
  const mapped = remapReferences(state, aliases);
  return {changed:true, report, state:{...mapped, parts:[...byKey.values()].map(normalizeStockPart).sort(compareParts),
    appliedInventoryBatches:[...new Set([...(state.appliedInventoryBatches || []),batch.id])],
    inventoryImportSummary:batch.summary,
    inventoryImports:[...(state.inventoryImports || []),report]}};
}
