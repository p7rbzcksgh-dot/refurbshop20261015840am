import { isPrintLine, editAssemblyQuantity } from './scanner-scope.js';
import { html, useState } from './vendor-preact-htm.js';
import { editHousingAllocation, editRequirement, housingTotal, housingByPart, orderWarnings } from './scanner-orders.js';

const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const partDesc=(line,state)=>line.description||state.parts.find(p=>p.pn===line.pn)?.desc||'';
const sum=rows=>rows.reduce((n,p)=>n+Number(p.qty||0),0);

export function ScannerOrderOverview() { return null; }

export function RequirementEditor({mo,line,state,onSave,onCancel,setNotice}) {
  const [v,set]=useState({pn:line.pn,qty:line.qty,description:partDesc(line,state),notes:line.notes||''});
  const save=()=>{try{onSave(editRequirement(mo,line.pn,v,state.parts));onCancel();setNotice('Part correction saved for this order.');}catch(e){setNotice(e.message);}};
  return html`<div class="requirement-editor">
    <div class="grid2"><label class="field">Part number<input class="in mono" value=${v.pn} onInput=${e=>set({...v,pn:e.target.value})}/></label><label class="field">Quantity<input class="in" type="number" min="0.001" step="any" value=${v.qty} onInput=${e=>set({...v,qty:e.target.value})}/></label></div>
    <label class="field">Description on this order<input class="in" value=${v.description} onInput=${e=>set({...v,description:e.target.value})}/></label>
    <label class="field">Notes / corrections<textarea class="in" value=${v.notes} onInput=${e=>set({...v,notes:e.target.value})}/></label>
    <div class="hint">A correction affects this MO only. New part numbers must exist in Parts & Inventory first. Quantities and notes are editable.</div>
    <div class="scope-actions"><button class="btn primary sm" onClick=${save}>Save part correction</button><button class="btn ghost sm" onClick=${onCancel}>Cancel</button></div>
  </div>`;
}

function GapEditor({gap,save}) {
 const [notes,set]=useState(gap.notes||'');
 return html`<div class="bom-gap"><div class="bom-gap-head"><div><strong class="mono">${gap.pn}</strong> · ${gap.description}</div><label class="checkline"><input type="checkbox" checked=${gap.resolved} onChange=${e=>save({...gap,notes,resolved:e.target.checked})}/>Resolved</label></div><textarea class="in" value=${notes} onInput=${e=>set(e.target.value)} onBlur=${()=>notes!==gap.notes&&save({...gap,notes})}/></div>`;
}
function HousingRow({row,mo,state,save,setNotice}) {
 const [open,setOpen]=useState(false);const [v,set]=useState({...row});
 const apply=()=>{try{save(editHousingAllocation(mo,row.id,v,state.parts));setOpen(false);setNotice('Housing allocation saved; only its quantity change was applied to the main parts list.');}catch(e){setNotice(e.message);}};
 return html`<div class="housing-row"><div class="housing-row-head"><div><span class="mono">${row.pn}</span><small>${row.parent} · BOM ${row.bomItem} · ${row.source}</small></div><b>× ${row.qty}</b><button class="btn ghost xs" onClick=${()=>{set({...row});setOpen(!open);}}>Edit allocation</button></div>${open&&html`<div class="housing-edit"><div class="grid2"><label class="field">Part number<input class="in mono" value=${v.pn} onInput=${e=>set({...v,pn:e.target.value})}/></label><label class="field">Included quantity<input class="in" type="number" min="0" step="any" value=${v.qty} onInput=${e=>set({...v,qty:e.target.value})}/></label></div><label class="field">Parent / housing section<input class="in" value=${v.parent} onInput=${e=>set({...v,parent:e.target.value})}/></label><label class="field">Notes<input class="in" value=${v.notes} onInput=${e=>set({...v,notes:e.target.value})}/></label><div class="scope-actions"><button class="btn primary sm" onClick=${apply}>Save allocation</button><button class="btn ghost sm" onClick=${()=>setOpen(false)}>Cancel</button></div></div>`}</div>`;
}
function AssemblyReference({task,mo,state,patch,setNotice}) {
 const [editing,setEditing]=useState(false),[value,setValue]=useState(task.qty??'');
 const save=()=>{try{const next=editAssemblyQuantity(mo,task.id,value,state.parts);patch(mo.id,()=>next);setEditing(false);setNotice('Assembly quantity updated. Refresh the print request after quantity changes.');}catch(e){setNotice(e.message);}};
 return html`<details class="assembly-ref"><summary><strong class="mono">${task.pn}</strong> ${task.qty==null?' · quantity pending':' ×'+task.qty} · ${task.description}</summary>
  <div class="assembly-quantity"><button class="btn ghost xs" onClick=${()=>{setValue(task.qty??'');setEditing(!editing);}}>Edit assembly quantity</button>${editing&&html`<label>Quantity <input class="in" type="number" min="0" step="1" aria-label=${'Assembly quantity '+task.pn} value=${value} onInput=${e=>setValue(e.target.value)}/></label><button class="btn primary xs" onClick=${save}>Apply quantity</button><button class="btn ghost xs" onClick=${()=>setEditing(false)}>Cancel</button>`}</div>
  ${task.notes&&html`<p>${task.notes}</p>`}<p class="hint">${task.source}</p>
  <div class="compact-bom-table">${(task.components||[]).filter(c=>!c.excluded).map(c=>html`<div><span class="mono">${c.pn}</span><span>${c.qty??c.qtyPerParent} ${c.uom||'EA'}${c.qty==null?' / assembly':''}</span><span>${c.printable?'3D print':'Part'}</span></div>`)}</div>
  <label class="checkline"><input type="checkbox" checked=${task.complete} onChange=${e=>patch(mo.id,current=>({...current,bomTasks:current.bomTasks.map(x=>x.id===task.id?{...x,complete:e.target.checked}:x)}))}/>Assembly complete</label>
 </details>`;
}
export function OrderScopePanel({mo,state,patch,setNotice}) {
 const gaps=(mo.bomGaps||[]).filter(g=>!g.resolved), warnings=orderWarnings(mo);
 if(!mo.seedBatch && !(mo.bomTasks||[]).length && !(mo.housing||[]).length)return null;
 return html`<div class="scanner-scope">
  ${warnings.map(w=>html`<div class="scope-warning">${w}</div>`)}
  ${(mo.bomGaps||[]).length>0&&html`<details class="job-section"><summary><span>Pending quantities / notes</span><small>${gaps.length} open</small></summary><div class="job-section-body">${(mo.bomGaps||[]).map(g=>html`<${GapEditor} key=${g.id} gap=${g} save=${next=>patch(mo.id,current=>({...current,bomGaps:current.bomGaps.map(x=>x.id===g.id?next:x)}))}/>`)}<p class="hint">Add the confirmed part and quantity in Required parts before resolving the note.</p></div></details>`}
  <details class="job-section"><summary><span>Assembly references</span><small>${(mo.bomTasks||[]).length}</small></summary><div class="job-section-body"><p class="hint">Components are included in Required parts; these are not extra stock picks.</p>${(mo.bomTasks||[]).map(task=>html`<${AssemblyReference} key=${task.id} task=${task} mo=${mo} state=${state} patch=${patch} setNotice=${setNotice}/>` )}</div></details>
  ${(mo.housing||[]).length>0&&!mo.hardwareDeferred&&html`<details class="job-section"><summary><span>Housing allocations</span><small>${housingTotal(mo)}</small></summary><div class="job-section-body">${mo.housing.map(row=>html`<${HousingRow} key=${row.id} row=${row} mo=${mo} state=${state} setNotice=${setNotice} save=${next=>patch(mo.id,()=>next)}/>` )}</div></details>`}
 </div>`;
}

export function manufacturingOrderCsvRows(mo,state) {
 return [['MO','Scanner','Part number','Description','Quantity','Unit','Supply source','Issued quantity','Section','Notes','Source references'],...(mo.parts||[]).map(p=>[mo.number,mo.serial,p.pn,partDesc(p,state),p.qty,p.uom||state.parts.find(x=>x.pn===p.pn)?.uom||'EA',p.source,p.issuedQty||0,p.section||'',p.notes||'',(p.references||[]).join(' | ')])];
}
export function manufacturingOrderHtml(mo,state) {
 const sections=[{title:'3D-print parts',parts:(mo.parts||[]).filter(isPrintLine)},{title:'Other replacement parts',parts:(mo.parts||[]).filter(p=>!isPrintLine(p))}];
 const tables=sections.map(g=>`<h2>${g.title}</h2><table><thead><tr><th>Part number</th><th>Description / assembly</th><th>Qty</th><th>Unit</th><th>Checked / correction</th></tr></thead><tbody>${g.parts.map(p=>`<tr><td class="mono">${esc(p.pn)}</td><td>${esc(partDesc(p,state))}<small>${esc(p.section||'')}</small></td><td class="num">${esc(p.qty)}</td><td>${esc(p.uom||state.parts.find(x=>x.pn===p.pn)?.uom||'EA')}</td><td></td></tr>`).join('')}</tbody></table>`).join('');
 const gaps=(mo.bomGaps||[]).filter(g=>!g.resolved);
 const assemblyLine=(mo.bomTasks||[]).filter(t=>Number(t.qty)>0).map(t=>`${esc(t.pn)} ×${esc(t.qty)}`).join(' · ');
 return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(mo.number)} ${esc(mo.serial)}</title><style>@page{size:letter;margin:12mm}*{box-sizing:border-box}body{font:11px Arial,sans-serif;color:#202b37;margin:24px}h1{font-size:23px;margin:5px 0}h2{font-size:15px;margin:19px 0 8px;break-after:avoid}table{width:100%;border-collapse:collapse;table-layout:fixed}thead{display:table-header-group}th{background:#253749;color:#fff;text-align:left;padding:6px}td{padding:6px;border-bottom:1px solid #cbd2d9;vertical-align:top;overflow-wrap:anywhere}tr{break-inside:avoid}th:nth-child(1){width:19%}th:nth-child(2){width:46%}th:nth-child(3){width:7%}th:nth-child(4){width:8%}th:nth-child(5){width:20%}.mono{font-family:monospace}.num{text-align:right}small{display:block;font-size:9px;color:#64717e;margin-top:2px}.hint{color:#52616d}.pending{border:1px solid #bdc6cc;padding:10px;margin:16px 0}.footer{font-size:10px;margin:18px 0}.no-print{margin-bottom:20px;padding:10px}@media print{body{margin:0}.no-print{display:none}}</style></head><body><button class="no-print" onclick="window.print()">Print / save PDF</button><b>TCG REFURB SHOP</b><h1>${esc(mo.number)} / ${esc(mo.serial)}</h1><p class="hint">${esc(mo.created||'')} · Manufacturing order${mo.hardwareDeferred?' · Bulk hardware deferred':''}</p><p class="hint"><b>Assemblies:</b> ${assemblyLine}<br>Components are included below, not additional stock picks.</p>${tables}${gaps.length?`<div class="pending"><b>Pending quantities</b>${gaps.map(g=>`<p><b>${esc(g.pn)}</b> — ${esc(g.notes)}</p>`).join('')}</div>`:''}<p class="hint">${esc(mo.notes||'')}</p><h2>Additional parts / corrections</h2><table><thead><tr><th>Part number</th><th>Description</th><th>Qty</th><th>Unit</th><th>Notes</th></tr></thead><tbody>${Array.from({length:5},()=>'<tr style="height:28px"><td></td><td></td><td></td><td></td><td></td></tr>').join('')}</tbody></table><div class="footer">Reviewed by: __________________________  Date: __________________</div></body></html>`;
}
export function openManufacturingOrder(mo,state) {
 const win=window.open('','_blank');if(!win)return false;try{win.opener=null;}catch{}
 win.document.write(manufacturingOrderHtml(mo,state));win.document.close();return true;
}
