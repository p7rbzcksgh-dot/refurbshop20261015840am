/* One-time scanner MO migration and editable, non-additive housing allocation rules.
   No network calls, no stock issues and no automatic manufacturing completions. */
import { scopedPrintLines } from './scanner-scope.js';
import { canonicalSerialKey } from './starter-records.js';
import { normalizeStockPart, partKey } from './inventory-utils.js';

const copy = value => structuredClone(value);
const qty = value => { const n=Number(value); if(!Number.isFinite(n)||n<0) throw new Error('Quantity must be a finite number, zero or greater.'); return n; };
export function housingTotal(mo) { return (mo.housing||[]).reduce((n,r)=>n+Number(r.qty||0),0); }
export function housingByPart(mo) { const map={}; for(const r of mo.housing||[]) map[r.pn]=(map[r.pn]||0)+Number(r.qty||0); return map; }
export function orderWarnings(mo) {
  const out=[];
  for(const [pn,base] of Object.entries(mo.rules||{})) {
    if(!['FAS0119','OTS0063'].includes(pn)) continue;
    const n=(mo.parts||[]).filter(p=>p.pn===pn).reduce((a,p)=>a+Number(p.qty),0);
    if(n!==base) out.push(`${pn}: current quantity ${n}; Craig's original rule is ${base} per scanner.`);
  }
  for(const [pn,n] of Object.entries(housingByPart(mo))) {
    const current=(mo.parts||[]).find(p=>p.pn===pn);
    if(!current || current.qty<n) out.push(`${pn}: ${n} pieces are allocated to housing, more than the current total requirement. Edit the housing allocation or total.`);
  }
  if((mo.parts||[]).some(p=>['SA006','SA092'].includes(p.pn))) out.push('M1/M2 assembly code added: use OTS0063 x2 unless intentionally changing the confirmed motor scope.');
  return out;
}

/** Housing is already included in requirements. A change moves only the DELTA. */
export function editHousingAllocation(mo, id, values, inventory=[]) {
  const found=(mo.housing||[]).find(row=>row.id===id);
  if(!found) throw new Error('Housing allocation no longer exists.');
  const next={...found,...values,pn:String(values.pn??found.pn).trim(),qty:qty(values.qty??found.qty)};
  if(!next.pn) throw new Error('A housing part number is required.');
  if(!inventory.some(p=>p.pn===next.pn)) throw new Error('Add this part to Parts & Inventory first, then select it here.');
  const parts=copy(mo.parts||[]);
  function change(pn,delta) {
    let row=parts.find(p=>p.pn===pn);
    if(!row && delta<0) throw new Error('The housing part is missing from the main parts list. Restore it before changing its allocation.');
    if(!row) { const p=inventory.find(p=>p.pn===pn);row={pn,qty:0,description:p?.desc||pn,module:'scanner',source:p?.category==='3DP'?'print':'external',issuedQty:0,fulfilled:false,section:'Housing adjustment',notes:'Added through the included housing breakdown.',references:[]}; parts.push(row); }
    const updated=Number(row.qty)+delta;
    if(updated<0 || updated<(Number(row.issuedQty)||0)) throw new Error('This would reduce the total below zero or already issued stock. Return stock and correct the main quantity first.');
    row.qty=updated; row.fulfilled=false;
  }
  if(next.pn===found.pn) change(found.pn,next.qty-found.qty);
  else {change(found.pn,-found.qty);change(next.pn,next.qty);}
  return {...mo,parts:parts.filter(p=>p.qty>0),housing:mo.housing.map(row=>row.id===id?next:row)};
}

/** Per-MO correction, not a global inventory rename. Existing issued stock is protected. */
export function editRequirement(mo, oldPn, values, inventory) {
  const before=(mo.parts||[]).find(p=>p.pn===oldPn);
  if(!before) throw new Error('Part line no longer exists.');
  const pn=String(values.pn??oldPn).trim(); const n=qty(values.qty??before.qty);
  if(!pn || n<=0) throw new Error('Part number and quantity greater than zero are required.');
  if(!inventory.some(p=>p.pn===pn)) throw new Error('Add the corrected number in Parts & Inventory first.');
  if(pn!==oldPn && (mo.parts||[]).some(p=>partKey(p.pn)===partKey(pn))) throw new Error('That number is already on this order. Edit the existing quantity instead of creating a duplicate.');
  if(Number(before.issuedQty)>0 && (pn!==oldPn || n<Number(before.issuedQty))) throw new Error('Return issued stock before changing its part number or reducing its quantity.');
  const p=inventory.find(p=>p.pn===pn);
  const line={...before,...values,pn,qty:n,fulfilled:false};
  if(pn!==oldPn){line.printable=p?.category==='3DP';line.uom=p?.uom||'EA';line.weightEach=p?.wt??null;line.printMaterials=[];}
  if(line.source==='print' && (p?.category!=='3DP'||line.printable===false)) line.source='external';
  return {...mo,parts:mo.parts.map(r=>r.pn===oldPn?line:r),housing:(mo.housing||[]).map(r=>r.pn===oldPn?{...r,pn}:r)};
}

export function applyScannerOrdersBatch(state, batch, importedAt=new Date().toISOString()) {
  if(!batch?.id || !Array.isArray(batch.jobs)) throw new Error('Invalid scanner-order batch');
  if((state.appliedRefurbOrderBatches||[]).includes(batch.id)) return {state,changed:false,report:state.refurbOrderImportSummary};
  const next=copy(state); next.parts||=[];next.machines||=[];next.mos||=[];
  const report={batchId:batch.id,importedAt,created:[],populated:[],preserved:[],addedParts:[],warnings:[]};
  const aliases=new Map();
  for(const p of next.parts) {aliases.set(partKey(p.pn),p.pn);for(const old of p.previousPartNumbers||[]) if(!aliases.has(partKey(old))) aliases.set(partKey(old),p.pn);}
  for(const p of batch.newParts||[]) if(!aliases.has(partKey(p.pn))) {next.parts.push(normalizeStockPart(p));aliases.set(partKey(p.pn),p.pn);report.addedParts.push(p.pn);}
  let counter=Math.max(Number(next.moCounter)||0,...next.mos.map(m=>Number(String(m.number).match(/^MO-(\d+)$/)?.[1])||0));
  for(const spec of batch.jobs) {
    const key=canonicalSerialKey(spec.serial,'scanner');
    let machine=next.machines.find(m=>canonicalSerialKey(m.serial,m.unitType)===key);
    if(!machine) {machine={id:`${batch.id}-${spec.serial}`,serial:spec.serial,unitType:'scanner',gen:null,grade:'',source:'',notes:'',status:'stDraft',received:'',needsReview:false};next.machines.push(machine);}
    const active=next.mos.filter(m=>!m.closed && (m.machineId===machine.id || canonicalSerialKey(m.serial,m.unitType)===key));
    if(active.length>1) {report.preserved.push({serial:spec.serial,reason:'Multiple open jobs already exist; review manually. No job overwritten.'});continue;}
    const existing=active[0];
    if(existing && ((existing.parts||[]).length || existing.printRequest || Object.entries(existing.workflow||{}).some(([k,v])=>k!=='modulesSeparated' && v) || (existing.upgrades||[]).some(u=>u.complete))) {
      report.preserved.push({serial:spec.serial,number:existing.number,reason:'Existing populated or progressed job retained. Seed not layered over it, to avoid double-counting or changing work in progress.'});continue;
    }
    const job=copy(spec);
    for(const line of job.parts) {
      const mapped=aliases.get(partKey(line.pn));
      if(mapped) line.pn=mapped;
      else {
        next.parts.push(normalizeStockPart({pn:line.pn,desc:line.description,category:line.source==='print'?'3DP':line.pn.startsWith('FAS')?'Hardware':'Other',qty:1,onHand:0,uom:'EA',notes:'Required by confirmed scanner job; recreated with zero stock, not a stock receipt.'}));
        aliases.set(partKey(line.pn),line.pn);report.addedParts.push(line.pn);
      }
    }
    for(const row of job.housing||[]) row.pn=aliases.get(partKey(row.pn))||row.pn;
    for(const task of job.bomTasks||[]) {
      task.pn=aliases.get(partKey(task.pn))||task.pn;
      for(const c of task.components||[]) c.pn=aliases.get(partKey(c.pn))||c.pn;
    }
    for(const gap of job.bomGaps||[]) gap.pn=aliases.get(partKey(gap.pn))||gap.pn;
    const number=existing?.number || `MO-${String(++counter).padStart(4,'0')}`;
    const mo={...job,...(existing||{}),id:existing?.id||`mo-${batch.id}-${spec.serial}`,number,machineId:machine.id,serial:machine.serial,gen:machine.gen||null,
      unitType:'scanner',created:existing?.created||batch.date,closed:false,parts:job.parts,housing:job.housing,bomTasks:job.bomTasks,bomGaps:job.bomGaps,rules:job.rules,
      notes:[existing?.notes,job.notes].filter(Boolean).join('\n\n'),
      modules:existing?.modules?.length?existing.modules:[{id:'module-scanner',type:'scanner',serial:machine.serial,inspected:false,condition:'pending',notes:''}],
      upgrades:existing?.upgrades||[],workflow:{refurbReceived:false,modulesSeparated:true,inspectionComplete:false,scopeComplete:false,partsReady:false,teardownComplete:false,cleaningComplete:false,upgradesComplete:false,pretestPassed:false,testingHandoff:false,...(existing?.workflow||{})},
      pretest:existing?.pretest||{tester:'',date:'',notes:''},seedBatch:batch.id,seedSerial:spec.serial,
      printRequest:{number:`RPR-${number.replace(/^MO-/,'')}`,revision:1,status:'draft',generatedAt:importedAt,confirmedAt:'',startedAt:'',readyAt:'',notes:'',lines:scopedPrintLines(job)}}
    if(existing) {next.mos=next.mos.map(m=>m.id===existing.id?mo:m);report.populated.push({serial:mo.serial,number:mo.number});}
    else {next.mos.push(mo);report.created.push({serial:mo.serial,number:mo.number});}
  }
  next.moCounter=counter;
  next.appliedRefurbOrderBatches=[...(next.appliedRefurbOrderBatches||[]),batch.id];
  next.refurbOrderImportSummary=report;
  return {state:next,changed:true,report};
}

/** Apply newly provided BOM details without resetting saved manufacturing orders.
 *  Only adds missing line items; already-edited quantities and issued stock are unchanged.
 *  In-progress and closed orders are deliberately left unchanged for manual review.
 */
export function applyScannerBomSupplement(state, batch, revision='bom-supplement-20261014-v1') {
  if ((state.appliedRefurbBomSupplements||[]).includes(revision)) return {state,changed:false,report:null};
  const next=copy(state), report={updated:[],preserved:[],addedInventory:[]};
  next.parts||=[];
  const aliases=new Map();
  for (const p of next.parts) {aliases.set(partKey(p.pn),p.pn);for(const a of p.previousPartNumbers||[])if(!aliases.has(partKey(a)))aliases.set(partKey(a),p.pn);}
  const specs=new Map(batch.jobs.map(j=>[j.serial,j]));
  for(const mo of next.mos||[]) {
    const spec=specs.get(mo.serial);
    if(!spec || mo.seedBatch!==batch.id)continue;
    const editedOrProgressed=mo.closed || (mo.parts||[]).some(p=>Number(p.issuedQty||0)>0 || p.fulfilled) || (mo.printRequest && !['draft','cancelled'].includes(mo.printRequest.status));
    if(editedOrProgressed) {report.preserved.push(mo.serial);continue;}
    const before=new Set((mo.parts||[]).map(p=>partKey(p.pn)));
    const newParts=[];
    for(const line of spec.parts) {
      const code=aliases.get(partKey(line.pn))||line.pn;
      if(before.has(partKey(code)))continue;
      if(!aliases.has(partKey(code))) {
        const supplied=(batch.newParts||[]).find(x=>partKey(x.pn)===partKey(line.pn));
        next.parts.push(normalizeStockPart(supplied||{pn:code,desc:line.description,category:line.source==='print'?'3DP':'Other',qty:1,onHand:0,uom:'EA',notes:'Required by updated BOM; on-hand quantity has not been assumed.'}));
        aliases.set(partKey(code),code);report.addedInventory.push(code);
      }
      newParts.push({...copy(line),pn:code});before.add(partKey(code));
    }
    mo.parts.push(...newParts);
    // Replace reference metadata only, leaving all user-edited quantities and descriptions untouched.
    const priorTasks=new Map((mo.bomTasks||[]).map(t=>[t.id,t]));
    mo.bomTasks=spec.bomTasks.map(t=>{const older=priorTasks.get(t.id);return {...copy(t),complete:older?.complete??t.complete};});
    const priorGaps=new Map((mo.bomGaps||[]).map(g=>[g.id,g]));
    mo.bomGaps=spec.bomGaps.map(g=>{const older=priorGaps.get(g.id);return {...copy(g),resolved:g.resolved || older?.resolved || false,notes:(older && older.notes!==g.notes && !g.resolved)?older.notes:g.notes};});
    if(mo.printRequest?.status==='draft') {
      const seen=new Set((mo.printRequest.lines||[]).map(l=>partKey(l.pn)));
      mo.printRequest.lines.push(...newParts.filter(p=>p.source==='print' && !seen.has(partKey(p.pn))).map(p=>({pn:p.pn,qty:p.qty,module:'scanner'})));
      mo.printRequest.notes='Draft print request. Verify BOM association and current part quantities before issuing.';
    }
    report.updated.push({serial:mo.serial,added:newParts.length});
  }
  next.appliedRefurbBomSupplements=[...(next.appliedRefurbBomSupplements||[]),revision];
  return {state:next,changed:true,report};
}
