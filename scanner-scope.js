/* Scoped refurbishment requirements. No stock transactions or printer commands. */
import { partKey, normalizeStockPart } from './inventory-utils.js';
import { canonicalSerialKey } from './starter-records.js';

export const isFastener = pn => /^(?:OBS-)?FAS\d/i.test(String(pn||''));
export const isPrintLine = line => line?.source==='print' && line.printable!==false && !isFastener(line.pn) && !/^(?:SA\d|SSA\d|INASS\d|KIT\d|OTS\d|A\d)/i.test(line.pn);
export function scopedPrintLines(mo) {
  return (mo.parts||[]).filter(isPrintLine).map(p=>({pn:p.pn,qty:Number(p.qty),module:p.module||'scanner',description:p.description||'',uom:p.uom||'EA',weightEach:p.weightEach??null,printMaterials:p.printMaterials||[],section:p.section||'',references:p.references||[]})).sort((a,b)=>a.pn.localeCompare(b.pn));
}

/** Replaces old generated scope, rather than adding a second BOM over it.
 * Existing stock counts and transaction history are never adjusted by migration.
 * Previous order parts/print requests are retained as order history and the server
 * backs up the complete data file before persisting this change.
 */
export function applyScopedOrderRevision(state,batch,at=new Date().toISOString()) {
  const revision=batch.scopeRevision;
  if(!revision) throw new Error('Scope revision required');
  if((state.appliedRefurbBomSupplements||[]).includes(revision))return {state,changed:false,report:null};
  const next=structuredClone(state);
  const report={revision,at,updated:[],preserved:[],addedInventory:[]};
  next.parts||=[]; next.mos||=[];
  const aliases=new Map();
  for(const p of next.parts){aliases.set(partKey(p.pn),p.pn);for(const a of p.previousPartNumbers||[])if(!aliases.has(partKey(a)))aliases.set(partKey(a),p.pn);}
  for(const p of batch.newParts||[])if(!aliases.has(partKey(p.pn))){next.parts.push(normalizeStockPart(p));aliases.set(partKey(p.pn),p.pn);report.addedInventory.push(p.pn);}
  const mapped=pn=>aliases.get(partKey(pn))||pn;
  for(const mo of next.mos){
    const spec=batch.jobs.find(s=>canonicalSerialKey(s.serial,'scanner')===canonicalSerialKey(mo.serial,mo.unitType));
    if(!spec)continue;
    if(mo.closed){report.preserved.push({number:mo.number,serial:mo.serial,reason:'Closed order retained.'});continue;}
    if(!mo.seedBatch && !(mo.parts||[]).some(p=>p.masterQty!=null||p.scopeOrigin)){
      report.preserved.push({number:mo.number,serial:mo.serial,reason:'Unrelated manually created order retained.'});continue;
    }
    const alreadyCurrent=mo.scopeRevision===revision;
    const previousParts=structuredClone(mo.parts||[]);
    const existing=new Map(previousParts.map(p=>[partKey(p.pn),p]));
    const managed=new Set((spec.legacyManagedParts||[]).flatMap(pn=>[partKey(pn),partKey(mapped(pn))]));
    const desired=structuredClone(spec.parts).map(p=>({...p,pn:mapped(p.pn)}));
    const desiredCodes=new Set(desired.map(p=>partKey(p.pn)));
    const changes=[];
    const archivedIssued=[];
    for(const p of desired){
      const prior=existing.get(partKey(p.pn));
      if(!prior)continue;
      p.source=prior.source==='stock'?'stock':p.source;
      if(prior.source==='external' && p.printable && prior.scopeOrigin===revision)p.source='external';
      p.issuedQty=Number(prior.issuedQty||0);
      p.fulfilled=Boolean(prior.fulfilled) && p.qty<=Number(prior.qty);
      if(p.issuedQty>p.qty){p.requestedQty=p.qty;p.qty=p.issuedQty;changes.push(`${p.pn}: ${p.issuedQty} already issued; requested quantity ${p.requestedQty}. Return the excess before reducing this line.`);}
      if(prior.qty!==p.qty)changes.push(`${p.pn}: ${prior.qty} -> ${p.qty} ${p.uom}.`);
    }
    // Preserve extra manually entered non-hardware parts; do not preserve old generated extras.
    for(const p of previousParts){
      if(desiredCodes.has(partKey(p.pn)))continue;
      const inventory=next.parts.find(x=>partKey(x.pn)===partKey(p.pn));
      const isHardware=isFastener(p.pn)||inventory?.category==='Hardware'||(inventory?.previousPartNumbers||[]).some(isFastener);
      const generated=managed.has(partKey(p.pn))||p.masterQty!=null||p.scopeOrigin;
      if(!isHardware&&!generated){desired.push(p);desiredCodes.add(partKey(p.pn));continue;}
      if(Number(p.issuedQty||0)>0)archivedIssued.push(structuredClone(p));
      changes.push(`Removed ${p.pn} x${p.qty} from active requirements.`);
    }
    if(!alreadyCurrent){
      mo.scopeHistory=[...(mo.scopeHistory||[]),{revision:mo.scopeRevision||'previous',supersededAt:at,parts:previousParts,housing:structuredClone(mo.housing||[]),bomTasks:structuredClone(mo.bomTasks||[]),printRequest:structuredClone(mo.printRequest||null),notes:mo.notes||''}];
    }
    mo.parts=desired;
    mo.housing=[];
    mo.hardwareDeferred=true;
    mo.deferredIssuedHardware=[...(mo.deferredIssuedHardware||[]),...archivedIssued];
    mo.rules=structuredClone(spec.rules);
    mo.bomTasks=structuredClone(spec.bomTasks).map(t=>({...t,pn:mapped(t.pn),complete:(mo.bomTasks||[]).find(x=>x.pn===t.pn)?.complete||false,components:t.components.map(c=>({...c,pn:mapped(c.pn)}))}));
    mo.bomGaps=structuredClone(spec.bomGaps).map(g=>({...g,pn:mapped(g.pn)}));
    mo.scopeNotes=structuredClone(spec.scopeNotes||[]);
    mo.scopeRevision=revision;
    // Old generated notes are archived, while an operator's separately appended text is preserved.
    const oldNotes=String(mo.notes||'');
    const generatedNotes=/Full hardware master|437 hardware|Hardware kit|BOM update:|One-scanner refurb scope/i.test(oldNotes);
    mo.notes=(!generatedNotes&&oldNotes&&oldNotes!==spec.notes)?`${oldNotes}\n\n${spec.notes}`:spec.notes;
    if(archivedIssued.length)mo.notes+='\nPreviously issued removed parts are retained in order history; inventory was not automatically returned.';
    if(changes.some(s=>s.includes('already issued')))mo.notes+='\n'+changes.filter(s=>s.includes('already issued')).join('\n');
    if(!alreadyCurrent&&mo.workflow)mo.workflow.partsReady=false;
    const request=mo.printRequest||{};
    mo.printRequest={number:request.number||`RPR-${String(mo.number).replace(/^MO-/,'')}`,revision:alreadyCurrent?(request.revision||1):(Number(request.revision||0)+1),status:'draft',generatedAt:at,confirmedAt:'',startedAt:'',readyAt:'',notes:'',lines:scopedPrintLines(mo)};
    report.updated.push({serial:mo.serial,number:mo.number,parts:mo.parts.length,printLines:mo.printRequest.lines.length,printPieces:mo.printRequest.lines.reduce((n,p)=>n+p.qty,0),changes,archivedIssued:archivedIssued.map(p=>p.pn)});
  }
  next.appliedRefurbBomSupplements=[...(next.appliedRefurbBomSupplements||[]),revision];
  next.refurbScopeUpdate=report;
  return {state:next,changed:true,report};
}

/** Change one assembly allocation by its delta. Does not create a parent stock pick
 * or overwrite other assemblies' shares of a component. Printer request refresh
 * remains explicit after edits, and issued stock cannot be silently reduced. */
export function editAssemblyQuantity(mo, taskId, value, inventory=[]) {
  const amount=Number(value);
  if(value==='' || !Number.isSafeInteger(amount) || amount<0)throw new Error('Enter a whole assembly quantity, zero or greater.');
  const task=(mo.bomTasks||[]).find(t=>t.id===taskId);
  if(!task)throw new Error('Assembly reference no longer exists.');
  const prior=Number(task.qty||0),delta=amount-prior;
  const next=structuredClone(mo);
  const components=(task.components||[]).filter(c=>!c.excluded);
  for(const c of components) {
    const multiplier=Number(c.qtyPerParent);
    if(!Number.isFinite(multiplier)||multiplier<0)throw new Error('This component needs a per-assembly quantity first.');
    const change=delta*multiplier;
    if(!change)continue;
    let row=next.parts.find(p=>partKey(p.pn)===partKey(c.pn));
    const actual=Number(row?.qty||0)+change;
    if(actual<0 || actual<Number(row?.issuedQty||0))throw new Error(`Return issued ${c.pn} or correct its part quantity before reducing this assembly.`);
    if(!row && actual>0) {
      const part=inventory.find(p=>partKey(p.pn)===partKey(c.pn));
      if(!part)throw new Error(`Add ${c.pn} to Parts & Inventory first.`);
      const printable=Boolean(c.printable) && part.category==='3DP' && !isFastener(c.pn);
      row={pn:part.pn,qty:0,description:c.description||part.desc,module:'scanner',uom:c.uom||part.uom||'EA',source:printable?'print':'external',printable,issuedQty:0,fulfilled:false,section:`${task.pn} - ${task.description}`,references:[task.source||'Operator entered assembly quantity'],notes:'',weightEach:c.materials?.length?c.materials.reduce((n,m)=>n+Number(m.gramsEach||0),0):(c.weightEach??part.wt??null),printMaterials:c.materials||[],scopeOrigin:next.scopeRevision};
      next.parts.push(row);
    }
    if(row){row.qty=actual;row.fulfilled=false;}
  }
  next.parts=next.parts.filter(p=>Number(p.qty)>0);
  next.bomTasks=next.bomTasks.map(t=>t.id===taskId?{...t,qty:amount,status:'expanded',complete:false,components:t.components.map(c=>({...c,qty:Number(c.qtyPerParent)*amount}))}:t);
  if(next.workflow)next.workflow.partsReady=false;
  return next;
}
