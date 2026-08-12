import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage();
p.on('pageerror', e=>console.log('PAGEERROR:', e.message.slice(0,200)));
await p.goto('http://localhost:8000/euclid/book-1', { waitUntil:'networkidle' });
await p.waitForSelector('ul.tree .node-content', {timeout:15000});
await p.waitForTimeout(900);
for(let r=0;r<5;r++){
  const n=await p.evaluate(()=>{const bl=[...document.querySelectorAll('ul.tree .node-content[aria-expanded="false"] .toggle')];bl.slice(0,80).forEach(t=>t.click());return bl.length;});
  await p.waitForTimeout(800); if(!n) break;
}
console.log(JSON.stringify(await p.evaluate(async () => {
  // Select a CONSTRUCTION step (e-st = "4"), then open a citation from it.
  const rows=[...document.querySelectorAll('ul.tree .node-content')];
  const host=rows.find(r=>/Let the circle/.test(r.innerText));
  host.click();
  await new Promise(r=>setTimeout(r,600));
  const hostRn=host.closest('.node')._renderNode;
  const before={host_est:hostRn.state.get('e-st'), host_eid:hostRn.state.get('e-id')};
  const tog=[...host.querySelectorAll('.inline-toggle')][0];
  if(!tog) return {noToggle:true, before};
  tog.click();
  await new Promise(r=>setTimeout(r,1800));
  const kids=[...host.closest('li').querySelectorAll('.node-children .node-content')];
  const out=kids.slice(0,3).map(k=>{ const rn=k.closest('.node')._renderNode;
    return {row:k.innerText.replace(/\n/g,' ').slice(0,34), e_st:String(rn.state.get('e-st')), e_id:rn.state.get('e-id')}; });
  return {cite:tog.textContent.trim(), before, transcluded:out};
}), null, 2));
await b.close();
