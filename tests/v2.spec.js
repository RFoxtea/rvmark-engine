import { test } from '@playwright/test';
test('row metrics with vs without badge', async ({ page }) => {
  await page.goto('http://localhost:8000/');
  await page.waitForTimeout(700);
  const r = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.node-content')];
    const withBadge = rows.find(c => { const b=c.querySelector('.toggle-badge'); return b && getComputedStyle(b).display!=='none'; });
    const noBadge   = rows.find(c => { const b=c.querySelector('.toggle-badge'); return !b || getComputedStyle(b).display==='none'; });
    const probe = (c) => { if(!c) return null;
      const tog=c.querySelector('.toggle'), lbl=c.querySelector('.node-label');
      const rb=(e)=>e?+e.getBoundingClientRect().top.toFixed(2):null;
      const s=getComputedStyle(tog,'::before');
      return { rowH:+c.getBoundingClientRect().height.toFixed(2),
               togTop:rb(tog), lblTop:rb(lbl),
               togMinusLbl:+((rb(tog))-(rb(lbl))).toFixed(2) }; };
    return { withBadge: probe(withBadge), noBadge: probe(noBadge) };
  });
  console.log(JSON.stringify(r,null,1));
});
