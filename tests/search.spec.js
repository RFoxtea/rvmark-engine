/**
 * search.spec.js — the {searchable}-scoped search widget.
 *
 * Stepping to a match (Enter/Shift+Enter) selects it via the tree's own
 * selection mechanism — same aria-selected/focus as a click. There is no
 * separate "search result" highlight; typing alone never moves selection.
 *
 * Fixture (tests/rvmark/index.rvmark):
 *   29. {#search-root-node; searchable; open} SEARCHABLE_TOP_TEXT
 *     29.1. {#search-child-visible} SEARCHABLE_VISIBLE_TEXT
 *     29.2. {#search-child-collapsed} SEARCHABLE_COLLAPSED_PARENT (collapsed)
 *       29.2.1. {#search-grandchild-collapsed} SEARCHABLE_NEEDLE_TEXT (unmounted)
 *     29.3. {#search-child-unrelated} Nothing interesting here
 *   30. {#search-unsearchable-node} SEARCHABLE_NEEDLE_TEXT (outside any {searchable} scope)
 *     30.1. {#search-unsearchable-child} Not covered by {searchable}
 *
 * tests/rvmark/searchable-dir/index.rvmark carries file-level {searchable}
 * in its meta block, inherited to every file under that directory.
 */

import { test, expect } from '@playwright/test';

async function waitForTree(page) {
  await expect(page.locator('#tree-scroll')).not.toHaveCSS('display', 'none');
  await page.waitForFunction(() => !!document.querySelector('li.node[id]')?._renderNode);
}

async function nodeContent(page, id) {
  await page.waitForFunction((id) => !!window._rvmarkFindNodes?.(id)?.[0]?.li?.id, id);
  const liId = await page.evaluate((id) => window._rvmarkFindNodes(id)[0].li.id, id);
  return page.locator(`#${liId} > .node-content`);
}

test.describe('search widget presence', () => {
  test('is absent on pages with no {searchable} scope', async ({ page }) => {
    await page.goto('/other/');
    await waitForTree(page);
    await expect(page.locator('.search-widget')).toHaveCount(0);
  });

  test('Ctrl+F is not intercepted on a page with no {searchable} scope', async ({ page }) => {
    await page.goto('/other/');
    await waitForTree(page);
    const prevented = await page.evaluate(() => new Promise((resolve) => {
      window.addEventListener('keydown', (e) => resolve(e.defaultPrevented), { once: true });
      const evt = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, cancelable: true, bubbles: true });
      window.dispatchEvent(evt);
    }));
    expect(prevented).toBe(false);
  });

  test('is present (but inactive) on the index page, which has a {searchable} node', async ({ page }) => {
    await page.goto('/');
    await waitForTree(page);
    await expect(page.locator('.search-widget')).toHaveCount(1);
    await expect(page.locator('.search-widget')).not.toHaveClass(/search-widget--active/);
  });
});

test.describe('Ctrl+F activation', () => {
  test('first Ctrl+F focuses the widget instead of native find', async ({ page }) => {
    await page.goto('/');
    await waitForTree(page);
    await page.keyboard.press('Control+f');
    await expect(page.locator('.search-widget')).toHaveClass(/search-widget--active/);
    await expect(page.locator('.search-input')).toBeFocused();
  });

  test('second Ctrl+F, while the widget is focused, is not intercepted', async ({ page }) => {
    await page.goto('/');
    await waitForTree(page);
    await page.keyboard.press('Control+f');
    await expect(page.locator('.search-input')).toBeFocused();

    const prevented = await page.evaluate(() => new Promise((resolve) => {
      window.addEventListener('keydown', (e) => resolve(e.defaultPrevented), { once: true });
      const evt = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, cancelable: true, bubbles: true });
      document.activeElement.dispatchEvent(evt);
    }));
    expect(prevented).toBe(false);
  });

  test('Escape restores focus to whatever had it before activation', async ({ page }) => {
    await page.goto('/');
    await waitForTree(page);
    const row = await nodeContent(page, 'search-child-visible');
    await row.click();
    await expect(row).toBeFocused();

    await page.keyboard.press('Control+f');
    await expect(page.locator('.search-input')).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(row).toBeFocused();
    await expect(page.locator('.search-widget')).not.toHaveClass(/search-widget--active/);
  });
});

test.describe('matching and stepping to results', () => {
  test('typing alone does not change tree selection', async ({ page }) => {
    await page.goto('/');
    await waitForTree(page);
    const before = await page.evaluate(() => window._rvmarkFindNodes?.('root')?.[0]?.li?.id
      ?? document.querySelector('[aria-selected="true"]')?.closest('li.node')?.id);

    await page.keyboard.press('Control+f');
    await page.locator('.search-input').fill('SEARCHABLE_VISIBLE_TEXT');

    const row = await nodeContent(page, 'search-child-visible');
    await expect(row).not.toHaveAttribute('aria-selected', 'true');

    const after = await page.evaluate(() => document.querySelector('[aria-selected="true"]')?.closest('li.node')?.id);
    expect(after).toBe(before);
  });

  test('Enter selects the first mounted match, same as a click would', async ({ page }) => {
    await page.goto('/');
    await waitForTree(page);
    await page.keyboard.press('Control+f');
    await page.locator('.search-input').fill('SEARCHABLE_VISIBLE_TEXT');
    await page.keyboard.press('Enter');

    const row = await nodeContent(page, 'search-child-visible');
    await expect(row).toHaveAttribute('aria-selected', 'true');
    await expect(row).toBeFocused();
  });

  test('a match outside any {searchable} scope is not found', async ({ page }) => {
    await page.goto('/');
    await waitForTree(page);
    await page.keyboard.press('Control+f');
    await page.locator('.search-input').fill('SEARCHABLE_NEEDLE_TEXT');
    await page.keyboard.press('Enter');

    // search-unsearchable-node contains this text too, but isn't in scope,
    // so Enter must not have selected it.
    const row = await nodeContent(page, 'search-unsearchable-node');
    await expect(row).not.toHaveAttribute('aria-selected', 'true');
  });

  test('a match under a collapsed node marks the ancestor toggle, without expanding it', async ({ page }) => {
    await page.goto('/');
    await waitForTree(page);

    const collapsedRow = await nodeContent(page, 'search-child-collapsed');
    await expect(collapsedRow).toHaveAttribute('aria-expanded', 'false');

    await page.keyboard.press('Control+f');
    await page.locator('.search-input').fill('SEARCHABLE_NEEDLE_TEXT');

    await expect(collapsedRow.locator('.toggle')).toHaveClass(/toggle--has-match/);
    // Still collapsed — search must never force a reveal.
    await expect(collapsedRow).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#tree-root #search-grandchild-collapsed')).toHaveCount(0);
  });

  test('expanding the collapsed node then lets Enter select the newly-mounted match', async ({ page }) => {
    await page.goto('/');
    await waitForTree(page);
    await page.keyboard.press('Control+f');
    await page.locator('.search-input').fill('SEARCHABLE_NEEDLE_TEXT');

    const collapsedRow = await nodeContent(page, 'search-child-collapsed');
    await collapsedRow.locator('.toggle').click();
    await expect(collapsedRow).toHaveAttribute('aria-expanded', 'true');

    // Re-typing (input event) recomputes matches against the now-mounted node.
    await page.locator('.search-input').fill('SEARCHABLE_NEEDLE_TEX');
    await page.locator('.search-input').fill('SEARCHABLE_NEEDLE_TEXT');
    await page.keyboard.press('Enter');

    const grandchild = await nodeContent(page, 'search-grandchild-collapsed');
    await expect(grandchild).toHaveAttribute('aria-selected', 'true');
  });
});

test.describe('directory-level {searchable} inheritance', () => {
  test('a file under searchable-dir/ is in scope without its own node-level flag', async ({ page }) => {
    await page.goto('/searchable-dir/');
    await waitForTree(page);
    await expect(page.locator('.search-widget')).toHaveCount(1);

    await page.keyboard.press('Control+f');
    await page.locator('.search-input').fill('SEARCHABLE_DIR_NEEDLE');
    await page.keyboard.press('Enter');

    const row = await nodeContent(page, 'search-dir-child');
    await expect(row).toHaveAttribute('aria-selected', 'true');
  });
});

test.describe('?--static view', () => {
  test('search widget is entirely absent', async ({ page }) => {
    await page.goto('/?--static');
    await expect(page.locator('.search-widget')).toHaveCount(0);
    await expect(page.locator('#search-root')).toBeEmpty();
  });
});
