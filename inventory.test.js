import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {partKey,partFromCsvRow,normalizeStockPart,exclusionReason,inferPartGens,matchesPart,applyInventoryBatch,editInventoryPart,partInUse} from './inventory-utils.js';
const root=path.dirname(fileURLToPath(import.meta.url));
const batch=JSON.parse(fs.readFileSync(path.join(root,'inventory-batch.json'),'utf8'));
const legacy=JSON.parse(fs.readFileSync(path.join(root,'seed-parts.json'),'utf8'));
const fresh=()=>({parts:[],machines:[],mos:[],inventoryLog:[],appliedStarterBatches:[],appliedInventoryBatches:[]});
const seed=()=>applyInventoryBatch(fresh(),batch,legacy).state;

test('all nine CSVs accounted for: 3777 rows, 2118 distinct codes, 1692 retained and 426 excluded',()=>{
 assert.equal(batch.summary.sources.length,9);assert.equal(batch.summary.rowsRead,3777);
 assert.equal(batch.summary.sources.reduce((n,s)=>n+s.rows,0),3777);
 assert.equal(batch.parts.length,1692);assert.equal(batch.excluded.length,426);
 const all=[...batch.parts,...batch.excluded].map(p=>partKey(p.pn));
 assert.equal(new Set(all).size,2118);assert.equal(batch.summary.duplicateRowsRemoved,1659);
 assert.ok(batch.parts.every(p=>typeof p.pn==='string' && p.pn.trim()));
});
test('stock snapshot precedence is explicit and duplicate quantities are not summed',()=>{
 const part=pn=>batch.parts.find(p=>p.pn===pn);
 assert.equal(part('MFG0015').onHand,512);assert.equal(part('MFG0017').onHand,852);
 assert.equal(part('MA09').onHand,28);assert.equal(part('MFG0381').onHand,150);
 assert.match(part('MFG0015').quantitySource,/inventory_20260928/);
 assert.equal(batch.summary.stockDifferences,15);
});
test('3D printed components, assemblies, fasteners and legacy OBS revisions remain',()=>{
 assert.equal(batch.parts.filter(p=>p.groupNumber==='3DP').length,277);
 assert.equal(batch.parts.filter(p=>p.groupName==='Insert Assembly').length,31);
 assert.equal(batch.parts.filter(p=>p.groupName==='Small Assembly').length,15);
 assert.equal(batch.parts.filter(p=>p.groupNumber==='FSTN').length,187);
 assert.ok(batch.parts.some(p=>p.status==='OBS'));
 assert.ok(batch.parts.every(p=>!exclusionReason(p)));
 for(const p of legacy)assert.ok(batch.parts.some(x=>partKey(p.pn)===partKey(x.pn)),p.pn);
});
test('exclusions distinguish polymer components, machine motors and PPE from filament / office items',()=>{
 assert.ok(exclusionReason({'Part No.':'X','Group number':'AG00025','Part description':'Notebook'}));
 assert.ok(exclusionReason({'Part No.':'X','Group number':'R&D','Part description':'PETG Filament 1kg'}));
 assert.equal(exclusionReason({'Part No.':'MFG001','Group number':'3DP','Part description':'PETG printed bracket'}),'');
 assert.equal(exclusionReason({'Part No.':'RND1','Group number':'R&D','Part description':'Nema motor for CNC 3D Printer'}),'');
 assert.equal(exclusionReason({'Part No.':'X','Group number':'AG00017','Part description':'Nitrile Gloves - XL'}),'');
 assert.equal(batch.parts.some(p=>['AG00025','AG00022','AG00016','AG00014','AG00019'].includes(p.groupNumber)),false);
});
test('CSV converter reads real MRPeasy fields, keeps zeros, decimal stock and non-3DP categories',()=>{
 const p=partFromCsvRow({'Part No.':'FAS0001','Part description':'Screw','Group number':'FSTN','In stock':'10','Quantity':'0.25','QTY Per Machine':'0','Weight':'2.4','UoM':'EA','Vendor name':'Supplier','Reorder point':'2','Default storage location':'B1','Average cost':'0.13'});
 assert.equal(p.category,'Hardware');assert.equal(p.onHand,0.25);assert.equal(p.qty,0);assert.equal(p.wt,2.4);
 assert.equal(p.uom,'EA');assert.equal(p.minStock,2);assert.equal(p.location,'B1');assert.equal(p.vendor,'Supplier');
 assert.equal(p.csvFields['Average cost'],'0.13');
 assert.equal(partFromCsvRow({'Part No.':'FAS0001','Quantity':'0','In stock':'10'}).onHand,0);
});
test('search handles code, description words, group, supplier, material, old aliases and punctuation',()=>{
 const p=normalizeStockPart({pn:'MFG-0015',desc:'Bottom Diffuser Panel',groupName:'Manufacturing',vendor:'Test Vendor',material:'Aluminium',previousPartNumbers:['OLD-0015']});
 for(const q of ['mfg0015','bottom panel','aluminium vendor','Manufacturing','OLD-0015'])assert.equal(matchesPart(p,q),true,q);
 assert.equal(matchesPart(p,'nonsense'),false);assert.equal(matchesPart(p,'   '),true);
});
test('generations include PR7 and explicit ranges but blank fits remain unspecified',()=>{
 assert.deepEqual(inferPartGens('PR3-PR7 bracket'),[3,4,5,6,7]);
 assert.deepEqual(inferPartGens('PR1 module'),[1]);assert.deepEqual(inferPartGens('Generic bracket'),[]);
 assert.deepEqual(normalizeStockPart({gens:[7,3,7,99]}).gens,[3,7]);
});
test('distinct codes, zero padding and OBS suffixes are not collapsed by description',()=>{
 assert.equal(partKey(' fas0001  '),partKey('FAS0001'));
 assert.notEqual(partKey('FAS0001'),partKey('FAS001'));
 assert.notEqual(partKey('MFG001'),partKey('MFG001-OBS'));
 const state=applyInventoryBatch(fresh(),{id:'test',parts:[{pn:'X',desc:'Same'},{pn:'X-OBS',desc:'Same'}],excluded:[]}).state;
 assert.equal(state.parts.length,2);
});
test('inventory seeding is one-time: changes, renamed parts and deletions survive reapplication',()=>{
 let state=seed();const original=state.parts[0].pn;
 state=editInventoryPart(state,original,{pn:'CUSTOM-EDIT',desc:'Edited',onHand:2.75,notes:'Keep'});
 state.parts=state.parts.filter(p=>p.pn!=='MFG0015');const out=applyInventoryBatch(state,batch,legacy);
 assert.equal(out.changed,false);assert.ok(out.state.parts.some(p=>p.pn==='CUSTOM-EDIT' && p.onHand===2.75));
 assert.equal(out.state.parts.some(p=>p.pn==='MFG0015' || p.pn===original),false);
});
test('unchanged old seed records gain source inventory quantities and weights',()=>{
 const state=fresh();state.parts=legacy.map(p=>normalizeStockPart({...p,category:'3DP'}));
 const out=applyInventoryBatch(state,batch,legacy);
 assert.equal(out.report.replacedUntouchedSeed,legacy.length);assert.equal(out.state.parts.length,batch.parts.length);
 for(const part of out.state.parts)if(legacy.some(p=>p.pn===part.pn))assert.equal(part.onHand,batch.parts.find(p=>p.pn===part.pn).onHand);
});
test('real existing edits and stock movements are kept, with a CSV snapshot to review',()=>{
 const state=fresh(),p=legacy[0];
 state.parts=[normalizeStockPart({...p,category:'3DP',desc:'Craig edited this',onHand:14.5,notes:'Do not replace'})];
 const out=applyInventoryBatch(state,batch,legacy),part=out.state.parts.find(x=>x.pn===p.pn);
 assert.equal(part.desc,'Craig edited this');assert.equal(part.onHand,14.5);assert.equal(part.notes,'Do not replace');
 assert.ok(part.importSnapshot);assert.ok(part.groupName);assert.equal(out.report.enriched,1);
});
test('existing duplicate codes merge without summing and referenced excluded parts are protected',()=>{
 const state=fresh();state.parts=[normalizeStockPart({pn:'fas0001',onHand:5}),normalizeStockPart({pn:'FAS0001',onHand:7}),normalizeStockPart({pn:'OFFICE',onHand:1})];
 state.mos=[{id:'job',parts:[{pn:'FAS0001',qty:1},{pn:'OFFICE',qty:1}],printRequest:{lines:[{pn:'FAS0001',qty:1}]}}];
 const out=applyInventoryBatch(state,{id:'test',parts:[],excluded:[{pn:'OFFICE',reason:'Office supplies'}]});
 assert.equal(out.state.parts.length,2);assert.equal(out.state.parts[0].onHand,5);
 assert.equal(out.state.mos[0].parts[0].pn,'fas0001');assert.equal(out.state.mos[0].printRequest.lines[0].pn,'fas0001');
 assert.equal(out.report.retainedReferencedExcluded.length,1);assert.equal(out.report.duplicateExisting.length,1);
});
test('all working fields and extra CSV metadata edit, and renaming repairs every linked part reference',()=>{
 const state=fresh();state.parts=[normalizeStockPart({pn:'PART-01',onHand:2})];
 state.mos=[{id:'open',parts:[{pn:'PART-01',qty:1}],printRequest:{lines:[{pn:'PART-01',qty:1}]}},{id:'closed',closed:true,parts:[{pn:'PART-01',qty:1}]}];
 state.inventoryLog=[{pn:'PART-01',delta:2}];
 const out=editInventoryPart(state,'PART-01',{pn:'PART-02',desc:'New name',category:'OTS',status:'OBS',onHand:4.5,minStock:1.25,qty:0.5,wt:12.5,gens:[7],location:'Bin 2',uom:'M',groupNumber:'OTS',groupName:'Off the Shelf',revision:'B',vendor:'Vendor A',vendorPart:'A-9',material:'Steel',finish:'Black',stockSize:'10',partType:'Rod',barcode:'00123',url:'https://example.invalid',notes:'Verified',csvFields:{Cost:'1.25'}});
 const p=out.parts[0];assert.equal(p.pn,'PART-02');assert.equal(p.onHand,4.5);assert.equal(p.csvFields.Cost,'1.25');assert.equal(p.vendorPart,'A-9');assert.equal(p.barcode,'00123');
 assert.ok(out.mos.every(m=>m.parts[0].pn==='PART-02'));assert.equal(out.mos[0].printRequest.lines[0].pn,'PART-02');
 assert.ok(out.inventoryLog.every(l=>l.pn==='PART-02'));assert.deepEqual(p.previousPartNumbers,['PART-01']);assert.equal(partInUse(out,'part-02'),true);
});
test('duplicate part edits, blank codes and invalid quantities are rejected without mutation',()=>{
 const state=fresh();state.parts=[normalizeStockPart({pn:'A'}),normalizeStockPart({pn:'B'})];
 for(const change of [{pn:' b '},{pn:''},{onHand:-1},{onHand:'bad'},{wt:-2}])assert.throws(()=>editInventoryPart(state,'A',change));
 assert.equal(state.parts[0].pn,'A');assert.equal(state.parts[0].onHand,0);
});
async function runServer(dir){
 const child=spawn(process.execPath,[path.join(root,'server.js')],{env:{...process.env,PORT:'0',DATA_DIR:dir,REFURB_PASSCODE:'566218',AUTH_SECRET:'inventory-test-secret'},stdio:['ignore','pipe','pipe']});
 let output='';const url=await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{child.kill();reject(new Error(output));},7000);
  child.stdout.on('data',d=>{output+=d;const m=output.match(/TCG Refurb Shop on :(\d+)/);if(m){clearTimeout(timer);resolve('http://127.0.0.1:'+m[1]);}});
  child.stderr.on('data',d=>{output+=d;});child.once('exit',()=>{clearTimeout(timer);reject(new Error(output));});
 });
 const auth=await fetch(url+'/api/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({passcode:'566218'})});const cookie=auth.headers.get('set-cookie').split(';')[0];
 return {url,read:async()=> (await fetch(url+'/api/data',{headers:{Cookie:cookie}})).json(),save:async s=>fetch(url+'/api/data',{method:'PUT',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify(s)}),stop:()=>new Promise(resolve=>{child.once('exit',resolve);child.kill();})};
}
test('API saves full inventory edits and fractional MO quantities, blocks stale clients and survives restart',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'refurb-inventory-'));let server;
 try{
  server=await runServer(dir);let state=await server.read();assert.equal(state.parts.length,1693);assert.equal(state.parts.find(p=>p.pn==='MFG0442-OBS').onHand,0);assert.equal(state.machines.length,89);
  for(const name of ['inventory-batch.json','seed-parts.json','reports/cleaned-inventory.csv','data.json'])assert.equal((await fetch(server.url+'/'+name)).status,404);
  assert.equal((await fetch(server.url+'/inventory-utils.js')).status,200);assert.equal((await fetch(server.url+'/api/data')).status,401);
  state=editInventoryPart(state,'MFG0015',{pn:'TEST-PERSIST',desc:'Persistent part',onHand:512.75,notes:'Keep after restart',gens:[7],csvFields:{Cost:'8.75'}});
  state.parts=state.parts.filter(p=>p.pn!=='MFG0017');
  state.mos=[{id:'fractional',number:'MO-0001',parts:[{pn:'TEST-PERSIST',qty:0.75,issuedQty:0.25,source:'stock'}]}];
  let response=await server.save(state);assert.equal(response.status,200);state=await response.json();
  assert.equal(state.mos[0].parts[0].qty,0.75);assert.equal(state.mos[0].parts[0].issuedQty,0.25);
  const bad=structuredClone(state);bad.appliedInventoryBatches=[];assert.equal((await server.save(bad)).status,409);
  const duplicate=structuredClone(state);duplicate.parts.push({...duplicate.parts[0],pn:duplicate.parts[0].pn.toLowerCase()});assert.equal((await server.save(duplicate)).status,400);
  await server.stop();server=await runServer(dir);state=await server.read();
  const part=state.parts.find(p=>p.pn==='TEST-PERSIST');assert.equal(part.onHand,512.75);assert.equal(part.notes,'Keep after restart');assert.equal(part.csvFields.Cost,'8.75');assert.deepEqual(part.gens,[7]);
  assert.equal(state.parts.some(p=>p.pn==='MFG0015' || p.pn==='MFG0017'),false);assert.equal(state.machines.length,89);
 }finally{if(server)await server.stop();fs.rmSync(dir,{recursive:true,force:true});}
});
