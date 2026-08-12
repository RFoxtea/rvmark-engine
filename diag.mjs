import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage();
p.on('pageerror', e=>console.log('PAGEERROR:', e.message.slice(0,200)));
await p.goto('http://localhost:8000/euclid/book-1', { waitUntil:'networkidle' });
await p.waitForSelector('ul.tree .node-content', {timeout:15000});
await p.waitForTimeout(1000);
for(let r=0;r<5;r++){
  const n=await p.evaluate(()=>{const bl=[...document.querySelectorAll('ul.tree .node-content[aria-expanded="false"] .toggle')];bl.slice(0,80).forEach(t=>t.click());return bl.length;});
  await p.waitForTimeout(900); if(!n) break;
}
// Open a citation to Prop 1.11 from inside Prop 1.2's proof, then read e-id
// on the host row vs the transcluded child row.
console.log(JSON.stringify(await p.evaluate(async () => {
  const t=[...document.querySelectorAll('ul.tree .inline-toggle')].find(e=>e.textContent.includes('Prop. 1.1]'));
  const hostLi=t.closest('li');
  const hostRn=hostLi._renderNode;
  t.click();
  await new Promise(r=>setTimeout(r,1800));
  const kid=hostLi.querySelector('.node-children .node');
  const kidRn=kid&&kid._renderNode;
  const read=(rn,k)=>{ try { return rn.state.get(k); } catch(e){ return 'ERR:'+e.message; } };
  return {
    hostRow: hostRn.sourceNode.label.slice(0,40),
    host_eid: read(hostRn,'e-id'),
    kidRow: kidRn? kidRn.sourceNode.label.slice(0,40):null,
    kid_eid: kidRn? read(kidRn,'e-id'):null,
    kidDeclares: kidRn? String(kidRn.sourceNode.attrs.get('on-spawn')||'(none)').slice(0,60):null,
  };
}), null, 2));
await b.close();
