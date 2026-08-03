import { test } from '@playwright/test';
import { readFileSync } from 'fs';

test('check field-sizing includes placeholder', async ({ page }) => {
  const html = readFileSync('/tmp/fieldsizing.html', 'utf8');
  await page.setContent(html);
  const emptyWidth = await page.locator('#a').evaluate(el => el.getBoundingClientRect().width);
  await page.locator('#a').fill('Find in page…');
  const filledWidth = await page.locator('#a').evaluate(el => el.getBoundingClientRect().width);
  await page.locator('#a').fill('');
  const clearedWidth = await page.locator('#a').evaluate(el => el.getBoundingClientRect().width);
  console.log('empty(placeholder shown):', emptyWidth, 'filled(same text as value):', filledWidth, 'cleared(back to placeholder):', clearedWidth);
});
