import { chromium } from 'playwright';

const b = await chromium.launch();
const p = await b.newPage();
p.on('pageerror', e => console.log('PAGEERROR', e.message));
p.on('console', m => { if (m.type() === 'error') console.log('CONSOLE-ERR', m.text()); });

await p.goto('http://localhost:8000/euclid/book-1', { waitUntil: 'networkidle' });
await p.waitForTimeout(2500);

console.log(await p.evaluate(() => JSON.stringify({
  staticTrees: document.querySelectorAll('.static-tree').length,
  liveRows: document.querySelectorAll('.node-content').length,
  blockBodies: document.querySelectorAll('.block-body').length,
  cites: document.querySelectorAll('.cite').length,
  citesWired: document.querySelectorAll('.cite[aria-expanded]').length,
}, null, 2)));

// Expand the proposition chain and see if hydration happens on demand
const opened = await p.evaluate(async () => {
  const el = document.querySelector('[id="1"] , #\\31 ');
  return { found: !!el, id: el?.id ?? null };
});
console.log('prop node:', JSON.stringify(opened));
await b.close();
