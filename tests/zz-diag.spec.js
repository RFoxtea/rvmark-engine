import { test } from '@playwright/test';
test('diag', async ({ page }) => {
  await page.goto('http://localhost:8080/docs/philosophy/');
  await page.waitForTimeout(2500);
  const info = await page.evaluate(() => {
    const els = [...document.querySelectorAll('.inline-toggle, [data-rvmark-span]')]
      .filter(e => (e.textContent||'').includes('puer aeternus'));
    return els.map(e => ({
      html: e.outerHTML.slice(0, 200),
      cls: e.className,
      role: e.getAttribute('role'),
      ariaExpanded: e.getAttribute('aria-expanded'),
      markerTransform: (() => {
        const m = e.querySelector('.span-toggle-marker');
        return m ? getComputedStyle(m).transform : null;
      })(),
    }));
  });
  console.log(JSON.stringify(info, null, 1));
});
