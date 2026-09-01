import { chromium } from 'playwright';
const b = await chromium.launch();
const pg = await b.newPage({ viewport:{width:1400,height:900} });
await pg.goto('http://localhost:8000/bach',{waitUntil:'networkidle'});
await pg.waitForTimeout(700);
await pg.click('#rn-0 .node-label'); await pg.waitForTimeout(800);

const read = async () => await pg.evaluate(() => {
  const f=[...document.querySelectorAll('iframe')].find(x=>/viewer\.html/.test(x.src));
  return f ? 'panel-open' : 'no-panel';
});

const labels = await pg.evaluate(()=>[...document.querySelectorAll('#tree-root .node-label')].map((e,i)=>i+':'+e.textContent.trim().slice(0,28)));
console.log(labels.slice(0,5).join('\n'));

console.log('\nselect fugue 846:');
await pg.click('#rn-3 .node-content'); await pg.waitForTimeout(2200);
console.log('  ', await read());

console.log('select Score node:');
await pg.click('#rn-2 .node-content'); await pg.waitForTimeout(1800);
console.log('  ', await read());
await b.close();
