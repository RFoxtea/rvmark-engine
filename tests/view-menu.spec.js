/**
 * view-menu.spec.js — footer "view" drop-up and the ?--static view.
 *
 * The menu offers the two non-interactive views of the selected node: its
 * .rvmark source file and the build-time static rendering of its page. Both
 * retarget as selection moves, and both carry the node's permalinkId as a
 * fragment.
 */

import { test, expect } from '@playwright/test';

/**
 * The pathname+search+hash of a menu link. Hydrated nodes carry a full origin
 * in pageAddress, so hrefs may be absolute or root-relative; both resolve to
 * the same place, and only that place is under test.
 */
async function linkPath(page, i) {
  const href = await page.locator('footer .view-menu-items a').nth(i).getAttribute('href');
  const u = new URL(href, page.url());
  return u.pathname + u.search + u.hash;
}

/** Find a hydrated .node-content by its {#id} using findNodes. */
async function nodeContent(page, id) {
  await page.waitForFunction((id) => !!window._rvmarkFindNodes?.(id)?.[0]?.li?.id, id);
  const liId = await page.evaluate(
    (id) => window._rvmarkFindNodes(id)[0].li.id, id);
  return page.locator(`#${liId} > .node-content`);
}

test.describe('footer view menu', () => {
  test('menu is present and closed on load', async ({ page }) => {
    await page.goto('/');
    const menu = page.locator('footer .view-menu');
    await expect(menu).toBeVisible();
    await expect(menu).not.toHaveAttribute('open', '');
    await expect(menu.locator('.view-menu-items')).toBeHidden();
  });

  test('opens on click, revealing both view links', async ({ page }) => {
    await page.goto('/');
    await page.locator('footer .view-menu summary').click();
    const items = page.locator('footer .view-menu-items');
    await expect(items).toBeVisible();
    await expect(items.locator('a')).toHaveCount(2);
    await expect(items.locator('a').nth(0)).toHaveText('rvmark source');
    await expect(items.locator('a').nth(1)).toHaveText('static view');
  });

  test('show-hidden toggle lives inside the menu, not loose in the footer', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('footer .view-menu-items .show-hidden-toggle')).toHaveCount(1);
    // Nothing outside the menu should carry it any more.
    await expect(page.locator('footer > .show-hidden-toggle')).toHaveCount(0);
  });

  test('show-hidden toggle still works from inside the menu', async ({ page }) => {
    await page.goto('/');
    // Scope to the live tree: #static-content holds its own copy of every node.
    await expect(page.locator('#tree-root #child-hidden')).toHaveCount(0);

    await page.locator('footer .view-menu summary').click();
    await page.locator('footer .view-menu-items .show-hidden-toggle').click();
    await expect(page.locator('#show-hidden-cb')).toBeChecked();
    await expect(await nodeContent(page, 'child-hidden')).toBeVisible();

    await page.locator('footer .view-menu-items .show-hidden-toggle').click();
    await expect(page.locator('#show-hidden-cb')).not.toBeChecked();
  });

  test('both links open in a new tab', async ({ page }) => {
    await page.goto('/');
    for (const a of await page.locator('footer .view-menu-items a').all()) {
      await expect(a).toHaveAttribute('target', '_blank');
      await expect(a).toHaveAttribute('rel', 'noopener');
    }
  });

  test('source link points at the served .rvmark file', async ({ page }) => {
    await page.goto('/');
    expect(await linkPath(page, 0)).toBe('/_rvmark/index.rvmark');

    // And it actually resolves — the source view must not 404.
    const res = await page.request.get('/_rvmark/index.rvmark');
    expect(res.status()).toBe(200);
    expect(await res.text()).toContain('Root node');
  });

  test('links retarget to the selected node', async ({ page }) => {
    await page.goto('/');
    await (await nodeContent(page, 'child-a')).click();

    // The source file is the same page; the static view carries the fragment.
    await expect.poll(() => linkPath(page, 0)).toBe('/_rvmark/index.rvmark');
    await expect.poll(() => linkPath(page, 1)).toBe('/?--static#child-a');

    await (await nodeContent(page, 'child-b')).click();
    await expect.poll(() => linkPath(page, 1)).toBe('/?--static#child-b');
  });

  test('selecting a transcluded node targets its own source file', async ({ page }) => {
    await page.goto('/');
    // #child-cross-embed transcludes ./other#other-root, so the node that lands
    // in the tree there originates in other.rvmark — not the page being viewed.
    // The source link must follow the node, not the page.
    await (await nodeContent(page, 'other-root')).click();

    await expect.poll(() => linkPath(page, 0)).toBe('/_rvmark/other.rvmark');
    // ...and the static view follows it to the other page too.
    await expect.poll(() => linkPath(page, 1)).toBe('/other/?--static#other-root');
  });
});

test.describe('?--static view', () => {
  test('shows static content and no interactive tree', async ({ page }) => {
    await page.goto('/?--static');
    await expect(page.locator('#static-content')).toBeVisible();
    await expect(page.locator('#tree-scroll')).toBeHidden();
    // The static rendering mirrors the live tree's markup, so it is the
    // container that tells them apart, not the classes inside it.
    await expect(page.locator('#static-content > ul.tree')).toBeVisible();
  });

  test('static nodes carry permalinkId ids, so fragments anchor', async ({ page }) => {
    await page.goto('/?--static#child-b');
    const target = page.locator('#static-content #child-b');
    await expect(target).toBeAttached();
    await expect(target).toContainText('Child B');
  });

  test('has no show-hidden toggle — it drives runtime state that is not there', async ({ page }) => {
    await page.goto('/?--static');
    await expect(page.locator('.show-hidden-toggle')).toHaveCount(0);
    await expect(page.locator('#show-hidden-cb')).toHaveCount(0);
    // Nor a view menu: the static view has no selection to target, and would
    // otherwise offer a link to itself.
    await expect(page.locator('.view-menu')).toHaveCount(0);
  });

  test('static HTML ships no toggle even before JS runs', async ({ page }) => {
    // Guards the build output itself, independent of what hydration does.
    const res = await page.request.get('/');
    const html = await res.text();
    expect(html).not.toContain('show-hidden-cb');
    expect(html).not.toContain('show hidden');
  });

  test('normal load still hides static content and builds the tree', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#static-content')).toBeHidden();
    await expect(page.locator('#tree-scroll')).toBeVisible();
  });
});
