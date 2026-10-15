import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applyStarterBatch, canonicalSerialKey, compareUnits, updateQueueUnit } from './starter-records.js';
const root = path.dirname(fileURLToPath(import.meta.url));
const batch = JSON.parse(fs.readFileSync(path.join(root, 'starter-units.json'), 'utf8'));
const empty = () => ({ version: 2, parts: [], machines: [], mos: [], moCounter: 0, inventoryLog: [], appliedStarterBatches: [] });
const seeded = () => applyStarterBatch(empty(), batch, '2026-09-28T16:00:00Z').state;
const expected = {
  scanner: '002 008 018 029 030 035 043 048 049 050 056 063 066 067 092 102 132 150 151 152 171 172 188 197 201 252 264 305 340 345 350'.split(' ').map(x => 'SBX-' + x),
  conveyor: '009 029 030 031 047 062 066 072 083 102 116 125 126 128 135 138 139 143 146 152 171 178 22-191 196 229 303'.split(' ').map(x => 'CNV-' + x),
  chassis: '029 031 047 061 072 075 102 105 114 119 123 131 135 146 150 151 159 161 171 191 206 215 303 332 340 362 366 369 410'.split(' ').map(x => 'CHS-' + x),
};

test('all 86 serials are present and sorted, with 3 separate unnumbered notes', () => {
  const state = seeded();
  assert.equal(state.machines.length, 89);
  for (const type of Object.keys(expected)) {
    assert.deepEqual(state.machines.filter(u => u.unitType === type && u.serial).sort(compareUnits).map(u => u.serial), expected[type]);
  }
  assert.deepEqual(state.machines.filter(u => !u.serial).map(u => u.placeholderLabel), ['No S/N', 'Blank Box 3DP', 'Missing Box']);
});
test('no generations, grades, received dates or completed work are invented', () => {
  for (const unit of seeded().machines) {
    assert.equal(unit.gen, null); assert.equal(unit.grade, ''); assert.equal(unit.received, '');
    assert.equal(unit.status, 'stDraft'); assert.equal(unit.source, '');
  }
  assert.deepEqual(seeded().mos, []);
});
test('handwritten notes and uncertainty are retained without claiming work is complete', () => {
  const units = seeded().machines;
  assert.equal(units.filter(u => u.notes.includes('Not Disassembled')).length, 9);
  assert.match(units.find(u => u.serial === 'SBX-345').notes, /T\.D\./);
  assert.match(units.find(u => u.serial === 'CNV-083').notes, /237\?/);
  assert.equal(units.find(u => u.serial === 'CNV-066').needsReview, true);
  for (const serial of ['CNV-126', 'CNV-139', 'CNV-143']) assert.match(units.find(u => u.serial === serial).notes, /B0\/BO/);
});
test('one-time import does not resurrect changed or deleted starters', () => {
  let state = seeded(); const unit = state.machines[0];
  state = updateQueueUnit(state, unit.id, { ...unit, serial: 'SBX-003', notes: 'Craig correction', gen: 5, grade: 'MP', received: '2026-09-27' });
  state.machines = state.machines.filter(u => u.serial !== 'SBX-008');
  const result = applyStarterBatch(state, batch);
  assert.equal(result.changed, false); assert.equal(result.added, 0);
  assert.equal(result.state.machines.length, 88);
  assert.equal(result.state.machines.some(u => ['SBX-002', 'SBX-008'].includes(u.serial)), false);
  assert.equal(result.state.machines.find(u => u.id === unit.id).notes, 'Craig correction');
});
test('existing records and MO references are preserved and duplicates skipped', () => {
  const state = empty();
  const existing = { id: 'existing', serial: 'sbx 2', unitType: 'scanner', gen: 6, grade: 'NM', notes: 'Keep me', status: 'stTesting' };
  const mo = { id: 'old-mo', machineId: 'elsewhere', serial: 'CNV-009', unitType: 'conveyor', number: 'MO-0042' };
  state.machines.push(existing); state.mos.push(mo); state.moCounter = 42;
  const result = applyStarterBatch(state, batch);
  assert.equal(result.skipped, 2); assert.equal(result.added, 87);
  assert.deepEqual(result.state.machines[0], existing); assert.deepEqual(result.state.mos[0], mo);
  assert.equal(result.state.moCounter, 42);
});
test('serial normalization preserves zero-padded display strings and legacy year segments', () => {
  assert.equal(canonicalSerialKey('SBX-002'), canonicalSerialKey('sbx 2'));
  assert.equal(canonicalSerialKey('002', 'scanner'), canonicalSerialKey('SBX-002'));
  assert.notEqual(canonicalSerialKey('CNV-22-191'), canonicalSerialKey('CNV-191'));
  assert.notEqual(canonicalSerialKey('SBX-029'), canonicalSerialKey('CHS-029'));
});
test('all starter fields edit normally; ambiguous entries can be corrected', () => {
  const state = seeded(); const before = state.machines.find(u => u.serial === 'CNV-083');
  const next = updateQueueUnit(state, before.id, { ...before, serial: 'CHS-237', unitType: 'chassis', notes: 'Verified by Craig', needsReview: false, gen: 6, grade: 'HP', status: 'stAssessment', received: '2026-09-28', source: 'Bench A' });
  const after = next.machines.find(u => u.id === before.id);
  assert.equal(after.serial, 'CHS-237'); assert.equal(after.unitType, 'chassis'); assert.equal(after.needsReview, false);
  assert.equal(after.gen, 6); assert.equal(after.grade, 'HP'); assert.equal(after.status, 'stAssessment');
  assert.equal(after.source, 'Bench A'); assert.equal(after.received, '2026-09-28'); assert.equal(after.notes, 'Verified by Craig');
});
test('unnumbered notes can become real records without fabricated serials', () => {
  const state = seeded(); const before = state.machines.find(u => !u.serial);
  assert.throws(() => updateQueueUnit(state, before.id, { ...before, status: 'stAssessment' }), { code: 'identifyNoteFirst' });
  const next = updateQueueUnit(state, before.id, { ...before, serial: 'CHS-999', needsReview: false });
  assert.equal(next.machines.find(u => u.id === before.id).placeholderLabel, '');
});
test('duplicate edits are rejected, but changing fields on the same unit is allowed', () => {
  const state = seeded(); const first = state.machines[0];
  assert.throws(() => updateQueueUnit(state, first.id, { ...first, serial: 'sbx 8' }), { code: 'duplicateUnit' });
  assert.equal(updateQueueUnit(state, first.id, { ...first, notes: 'New note' }).machines[0].notes, 'New note');
});
test('open job serials follow corrections and closed-job snapshots remain intact', () => {
  const state = seeded(); const unit = state.machines[0]; unit.gen = 4;
  state.mos = [
    { id: 'open', machineId: unit.id, serial: unit.serial, gen: 4, closed: false, modules: [{ type: 'scanner', serial: unit.serial }] },
    { id: 'closed', machineId: unit.id, serial: unit.serial, gen: 4, closed: true, modules: [] },
  ];
  const next = updateQueueUnit(state, unit.id, { ...unit, serial: 'SBX-003', gen: 5 });
  assert.equal(next.mos[0].serial, 'SBX-003'); assert.equal(next.mos[0].gen, 5);
  assert.equal(next.mos[0].modules[0].serial, 'SBX-003'); assert.equal(next.mos[1].serial, 'SBX-002');
  assert.throws(() => updateQueueUnit(state, unit.id, { ...unit, unitType: 'chassis' }), { code: 'linkedTypeLocked' });
});

async function runServer(dir) {
  // Port 0 asks the operating system for a free test port.
  const child = spawn(process.execPath, [path.join(root, 'server.js')], { env: { ...process.env, PORT: '0', DATA_DIR: dir, REFURB_PASSCODE: '566218', AUTH_SECRET: 'test-only-secret' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const url = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Server startup timed out: ' + output)); }, 5000);
    child.stdout.on('data', data => {
      output += data;
      const match = output.match(/TCG Refurb Shop on :(\d+)/);
      if (match) { clearTimeout(timeout); resolve('http://127.0.0.1:' + match[1]); }
    });
    child.stderr.on('data', data => { output += data; });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error('Server exited: ' + code + ' ' + output)); });
  });
  const login = await fetch(url + '/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passcode: '566218' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  return {
    url, child,
    read: async () => (await fetch(url + '/api/data', { headers: { Cookie: cookie } })).json(),
    save: async state => {
      const response = await fetch(url + '/api/data', { method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(state) });
      assert.equal(response.status, 200); return response.json();
    },
    stop: () => new Promise(resolve => { if (child.exitCode !== null) return resolve(); child.once('exit', resolve); child.kill(); }),
  };
}

test('API persistence, private assets, empty unknowns and restart/deletion safety', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refurb-starters-test-'));
  let server;
  try {
    server = await runServer(dir);
    const state = await server.read();
    assert.equal(state.machines.length, 89); assert.equal(state.machines[0].gen, null); assert.equal(state.machines[0].received, '');
    assert.equal((await fetch(server.url + '/api/data')).status, 401);
    for (const file of ['starter-units.json', 'data.json', 'server.js', '.refurb-backups/anything.json']) assert.equal((await fetch(server.url + '/' + file)).status, 404);
    assert.equal((await fetch(server.url + '/starter-records.js')).status, 200);
    const first = state.machines[0]; first.serial = 'SBX-003'; first.notes = 'Keep this across restarts';
    state.machines = state.machines.filter(u => u.serial !== 'SBX-008');
    delete state.appliedStarterBatches;
    const saved = await server.save(state);
    assert.ok(saved.appliedStarterBatches.includes(batch.id));
    await server.stop(); server = await runServer(dir);
    const reloaded = await server.read();
    assert.equal(reloaded.machines.length, 88);
    assert.equal(reloaded.machines.some(u => ['SBX-002', 'SBX-008'].includes(u.serial)), false);
    assert.equal(reloaded.machines.find(u => u.id === first.id).notes, 'Keep this across restarts');
    // Even removing every unit is respected on the next restart.
    reloaded.machines = []; await server.save(reloaded);
    await server.stop(); server = await runServer(dir);
    assert.equal((await server.read()).machines.length, 0);
  } finally { if (server) await server.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('existing data is backed up before the additive one-time import', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refurb-existing-test-'));
  let server;
  try {
    const old = empty(); old.machines.push({ id: 'existing', serial: 'SBX-002', gen: 6, grade: 'HP', unitType: 'scanner', status: 'stTesting', received: '2026-08-15', notes: 'Existing real work' });
    const original = JSON.stringify(old); fs.writeFileSync(path.join(dir, 'data.json'), original);
    server = await runServer(dir); const state = await server.read();
    assert.equal(state.machines.length, 89); assert.equal(state.machines[0].notes, 'Existing real work');
    assert.equal(state.machines[0].status, 'stTesting'); assert.equal(state.machines[0].gen, 6);
    const backups = fs.readdirSync(path.join(dir, '.refurb-backups')); assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(path.join(dir, '.refurb-backups', backups[0]), 'utf8'), original);
    await server.stop(); server = await runServer(dir);
    assert.equal(fs.readdirSync(path.join(dir, '.refurb-backups')).length, 1);
  } finally { if (server) await server.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});
test('invalid live data is not overwritten by starter data', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refurb-invalid-test-'));
  const original = '{ broken data'; fs.writeFileSync(path.join(dir, 'data.json'), original);
  try {
    await assert.rejects(runServer(dir), /original file left untouched/);
    assert.equal(fs.readFileSync(path.join(dir, 'data.json'), 'utf8'), original);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
