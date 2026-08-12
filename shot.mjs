import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport:{width:900,height:700}, deviceScaleFactor:2 });
await p.goto('http://localhost:8000/euclid/book-1', { waitUntil:'networkidle' });
await p.waitForSelector('ul.tree .node-content', {timeout:15000});
await p.waitForTimeout(1000);
for(let r=0;r<5;r++){
  const n=await p.evaluate(()=>{const bl=[...document.querySelectorAll('ul.tree .node-content[aria-expanded="false"] .toggle')];bl.slice(0,80).forEach(t=>t.click());return bl.length;});
  await p.waitForTimeout(900); if(!n) break;
}
// Scroll a proof containing citations + highlight options into view.
const box = await p.evaluate(()=>{
  const t=[...document.querySelectorAll('ul.tree .inline-toggle')].find(e=>e.textContent.includes('Post. 3]'));
  const li=t.closest('li');
  li.scrollIntoView({block:'center'});
  const r=li.getBoundingClientRect();
  return {x:Math.max(0,r.x-10), y:Math.max(0,r.y-60), w:Math.min(880,r.width+20), h:260};
});
await p.waitForTimeout(500);
await p.screenshot({ path:'/tmp/claude-1000/-home-raf-dev-rvmark-rvmark-site/3b303959-369b-44ec-a9ad-cafb98577247/scratchpad/dotted.png', clip:{x:box.x,y:box.y,width:box.w,height:box.h} });
console.log('shot taken');
await b.close();
