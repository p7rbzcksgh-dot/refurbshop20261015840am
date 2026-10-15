/* Shared, dependency-free starter import and queue editing helpers.
   Starter records are ordinary saved records, never a live computed list. */
const TYPES = ['full', 'scanner', 'conveyor', 'chassis'];
const PREFIX = { scanner: 'SBX', conveyor: 'CNV', chassis: 'CHS', full: 'FULL' };
const GROUP_ORDER = { scanner: 0, conveyor: 1, chassis: 2, full: 3 };

/** Compare serials without case, spacing or zero-padding differences.
 * Preserve every numeric segment: CNV-22-191 is NOT CNV-191. */
export function canonicalSerialKey(value, type = 'full') {
  const raw = String(value || '').trim().toUpperCase().replace(/[\s_-]+/g, '-');
  if (!raw) return '';
  const module = raw.match(/^(SBX|CNV|CHS)-?(\d+(?:-\d+)*)$/);
  const numeric = raw.match(/^\d+(?:-\d+)*$/);
  if (module) return [module[1], ...module[2].split('-').map(n => String(Number(n)))].join(':');
  if (numeric) return [PREFIX[type] || type, ...raw.split('-').map(n => String(Number(n)))].join(':');
  return raw;
}

/** Sort SBX, CNV, CHS, then machines; sort on the final numeric serial segment.
 * This places the legacy CNV-22-191 at 191 and unnumbered notes at the end. */
export function compareUnits(a, b) {
  const group = (GROUP_ORDER[a.unitType] ?? 9) - (GROUP_ORDER[b.unitType] ?? 9);
  if (group) return group;
  if (Boolean(a.serial) !== Boolean(b.serial)) return a.serial ? -1 : 1;
  const an = String(a.serial || '').match(/(\d+)$/);
  const bn = String(b.serial || '').match(/(\d+)$/);
  if (an && bn && Number(an[1]) !== Number(bn[1])) return Number(an[1]) - Number(bn[1]);
  return String(a.serial || a.placeholderLabel || '').localeCompare(String(b.serial || b.placeholderLabel || ''), 'en', { numeric: true });
}

/** Add this batch once. Existing records and jobs are not rewritten.
 * The batch marker is retained even when a user edits or deletes every starter. */
export function applyStarterBatch(state, batch, importedAt = new Date().toISOString()) {
  if (!batch || typeof batch.id !== 'string' || !Array.isArray(batch.units)) throw new Error('Invalid starter batch');
  const applied = Array.isArray(state.appliedStarterBatches) ? state.appliedStarterBatches : [];
  if (applied.includes(batch.id)) return { state, changed: false, added: 0, skipped: 0 };
  const keys = new Set([...state.machines, ...state.mos].map(u => canonicalSerialKey(u.serial, u.unitType)).filter(Boolean));
  const ids = new Set(state.machines.map(u => u.id));
  const additions = [];
  let skipped = 0;
  for (let index = 0; index < batch.units.length; index++) {
    const unit = batch.units[index];
    if (!unit || !TYPES.includes(unit.unitType)) throw new Error('Invalid starter unit type');
    const serial = String(unit.serial || '').trim();
    const placeholderLabel = String(unit.placeholderLabel || '').trim();
    if (!serial && !placeholderLabel) throw new Error('Starter needs a serial or an unnumbered-note label');
    const id = `${batch.id}-${String(index + 1).padStart(3, '0')}`;
    const key = canonicalSerialKey(serial, unit.unitType);
    if (ids.has(id) || (key && keys.has(key))) { skipped++; continue; }
    additions.push({
      id, serial, unitType: unit.unitType, gen: null, grade: '', received: '',
      source: '', notes: String(unit.notes || ''), status: 'stDraft',
      placeholderLabel, needsReview: Boolean(unit.needsReview),
      starterBatch: batch.id, starterOriginalSerial: serial, starterImportedAt: importedAt,
    });
    ids.add(id);
    if (key) keys.add(key);
  }
  return {
    state: { ...state, machines: [...state.machines, ...additions], appliedStarterBatches: [...applied, batch.id] },
    changed: true, added: additions.length, skipped,
  };
}

function editError(code) { const error = new Error(code); error.code = code; throw error; }

/** Validate and apply an edit while maintaining open MO references.
 * Existing closed MOs keep their historical snapshots. */
export function updateQueueUnit(state, id, values) {
  const before = state.machines.find(unit => unit.id === id);
  if (!before) editError('unitMissing');
  const after = {
    ...before,
    serial: String(values.serial || '').trim(),
    unitType: TYPES.includes(values.unitType) ? values.unitType : before.unitType,
    gen: [1, 2, 3, 4, 5, 6, 7].includes(Number(values.gen)) ? Number(values.gen) : null,
    grade: ['NM', 'LP', 'MP', 'HP', 'DMG'].includes(values.grade) ? values.grade : '',
    received: String(values.received || '').trim(),
    source: String(values.source || '').trim(), notes: String(values.notes || '').trim(),
    status: values.status || before.status,
    placeholderLabel: String(values.placeholderLabel || '').trim(),
    needsReview: Boolean(values.needsReview),
  };
  if (!after.serial && !after.placeholderLabel) editError('serialOrLabelRequired');
  if (!after.serial && after.status !== 'stDraft') editError('identifyNoteFirst');
  if (after.received && (!/^\d{4}-\d{2}-\d{2}$/.test(after.received) || !Number.isFinite(Date.parse(after.received)))) editError('invalidReceivedDate');
  const key = canonicalSerialKey(after.serial, after.unitType);
  if (key && state.machines.some(u => u.id !== id && canonicalSerialKey(u.serial, u.unitType) === key)) editError('duplicateUnit');
  const linked = state.mos.filter(mo => mo.machineId === id);
  if (linked.length && after.unitType !== before.unitType) editError('linkedTypeLocked');
  if (linked.length && !after.serial) editError('identifyNoteFirst');
  if (linked.some(mo => !mo.closed) && !after.gen) editError('chooseGenerationFirst');
  if (after.serial) after.placeholderLabel = '';
  const mos = state.mos.map(mo => {
    if (mo.machineId !== id || mo.closed) return mo;
    return {
      ...mo, serial: after.serial, gen: after.gen,
      modules: (mo.modules || []).map(module => (
        after.unitType !== 'full' && module.type === after.unitType && (!module.serial || module.serial === before.serial)
          ? { ...module, serial: after.serial } : module
      )),
    };
  });
  return { ...state, machines: state.machines.map(u => u.id === id ? after : u), mos };
}
