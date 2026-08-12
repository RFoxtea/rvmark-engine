import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport:{width:900,height:700}, deviceScaleFactor:3 });
await p.goto('http://localhost:8000/euclid/book-1', { waitUntil:'networkidle' });
await p.waitForSelector('ul.tree .node-content', {timeout:15000});
await p.waitForTimeout(1000);
for(let r=0;r<4;r++){
  const n=await p.evaluate(()=>{const bl=[...document.querySelectorAll('ul.tree .node-content[aria-expanded="false"] .toggle')];bl.slice(0,80).forEach(t=>t.click());return bl.length;});
  await p.waitForTimeout(900); if(!n) break;
}
const box = await p.evaluate(()=>{
  const t=[...document.querySelectorAll('ul.tree .inline-toggle')].find(e=>/Post\. \d/.test(e.textContent));
  t.scrollIntoView({block:'center'});
  const r=t.getBoundingClientRect();
  return {x:Math.max(0,r.x-90), y:Math.max(0,r.y-16), w:280, h:50};
});
await p.waitForTimeout(400);
await p.screenshot({ path:'/tmp/claude-1000/-home-raf-dev-rvmark-rvmark-site/3b303959-369b-44ec-a9ad-cafb98577247/scratchpad/closeup.png', clip:box });
console.log('ok');
await b.close();
