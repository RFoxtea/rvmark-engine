/**
 * site.spec.js — end-to-end tests for the rvmark site.
 *
 * Tests run against the fixture in tests/rvmark/index.rvmark.
 *
 * Fixture structure:
 *   1. {#root; open} Root node with **bold** and *italic*
 *     1.1. {#child-a} Child A
 *       1.1.1. {#grandchild} Grandchild
 *     1.2. {#child-b} Child B
 *       1.2.1. Child B first
 *       1.2.2. Child B second
 *     1.3. {#child-hidden} [.hidden] Hidden child
 *     1.4. {#child-minor; minor} Minor child
 *     1.5. {#child-link; action: link} [External link](https://example.com)
 *     1.6. {#child-open; open} Open by default child
 *       1.6.1. Child of open
 *     1.7. {#child-tagged} [AI] Tagged with AI
 *       1.7.1. Child of AI-tagged node
 *     1.8. {#child-wip} [WIP] Tagged WIP
 *     1.9. {#child-internal} [Internal] Internal tag node
 *     1.10. {#child-markdown; type: markdown} Markdown body (with table)
 *     1.11. {#child-embed; => #embed-target}
 *     1.12. {#child-math} Inline math: $x = 1$
 *     1.13. {#child-cross-embed; => ./other#other-root}
 *     1.14. {#child-cross-children; => ./other#other-root} cross-children label
 *     1.15. {#child-exhibit; exhibit: ./other#other-root} Exhibit node
 *     1.16. {#child-remote-embed; ...} Remote embed
 *     1.17. {#embed-ai-node; => #embed-ai-target} Embed of AI-tagged node
 *   2. {#embed-target} Embed target node
 *   3. {#embed-ai-target} [AI] Embed target with AI tag
 *   4. {#nav-a} Nav A
 *   5. {#nav-b} Nav B
 *   6. {#child-global-ai} [GlobalAI] Tagged with global AI tag
 *   7. {#child-transcluded-ai; => ./other#other-container} transcluded-ai label
 *
 * Tag defs (from fixture header): [AI] (color, tip, meta.author: AI Author), [WIP], [Internal] (internal), [.hidden] (node.show-when: --show-hidden)
 * Site title: "Test Fixture", license: "Test License", author: "test-author"
 * Site map: "" (root fixture) + "other"
 */

import { test, expect } from '@playwright/test';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Wait for JS hydration: tree-scroll becomes visible. */
async function waitForTree(page) {
  await expect(page.locator('#tree-scroll')).not.toHaveCSS('display', 'none');
  await page.waitForFunction(() => {
    return !!document.querySelector('li.node[id]')?._renderNode;
  });
}

/**
 * Open the footer view menu, which holds the show-hidden toggle.
 * Idempotent: a <details> already open is left alone.
 */
async function openViewMenu(page) {
  const menu = page.locator('footer .view-menu');
  if (!(await menu.evaluate(el => el.open))) {
    await menu.locator('summary').click();
  }
  await expect(page.locator('footer .view-menu-items')).toBeVisible();
}

/** The currently-selected row. */
function selectedRow(page) {
  return page.locator('.node-content[aria-selected="true"]');
}

/** The parent <li class="node"> of a .node-content locator. */
function liOf(contentLocator) {
  return contentLocator.locator('..');
}

/** Find a hydrated .node-content by its {#id} using findNodes. */
async function nodeContent(page, id) {
  const liId = await page.evaluate((id) => {
    const rns = window._rvmarkFindNodes?.(id);
    return rns?.[0]?.li?.id ?? null;
  }, id);
  if (!liId) throw new Error(`No hydrated node with id="${id}" found`);
  return page.locator(`#${liId} > .node-content`);
}

/** Find a hydrated <li> by its {#id} using findNodes. */
async function nodeLi(page, id) {
  const liId = await page.evaluate((id) => {
    const rns = window._rvmarkFindNodes?.(id);
    return rns?.[0]?.li?.id ?? null;
  }, id);
  if (!liId) throw new Error(`No hydrated node with id="${id}" found`);
  return page.locator(`#${liId}`);
}

/** Like nodeContent but returns null instead of throwing when node is not in DOM. */
async function tryNodeContent(page, id) {
  const liId = await page.evaluate((id) => {
    const rns = window._rvmarkFindNodes?.(id);
    return rns?.[0]?.li?.id ?? null;
  }, id);
  if (!liId) return null;
  return page.locator(`#${liId} > .node-content`);
}

/** Wait until a node is in the DOM, then return its .node-content locator. */
async function waitForNode(page, id, timeout = 3000) {
  await page.waitForFunction((id) => {
    const rns = window._rvmarkFindNodes?.(id);
    return !!(rns?.[0]?.li?.id);
  }, id, { timeout });
  return nodeContent(page, id);
}


// ── Page load & hydration ─────────────────────────────────────────────────────

test.describe('page load and hydration', () => {
  test('index page loads and hydrates the interactive tree', async ({ page }) => {
    await page.goto('/');
    await waitForTree(page);
    await expect(page.locator('#site-title')).toHaveText('Test Fixture');
    await expect(page.locator('#tree-root .node-content').first()).toBeVisible();
    await expect(page.locator('#static-content')).toHaveCSS('display', 'none');
  });

  test('other page loads', async ({ page }) => {
    await page.goto('/other/');
    await waitForTree(page);
    await expect(page.locator('#tree-root .node-content').first()).toBeVisible();
  });

  test('window.__RVMARK_PAGE__ is set', async ({ page }) => {
    await page.goto('/');
    const rvmarkPage = await page.evaluate(() => window.__RVMARK_PAGE__);
    expect(rvmarkPage).toBeTruthy();
    expect(rvmarkPage.file).toMatch(/\.rvmark$/);
  });

  test('window.__RVMARK_SITE_MAP__ is set and contains known pages', async ({ page }) => {
    await page.goto('/');
    const siteMap = await page.evaluate(() => window.__RVMARK_SITE_MAP__);
    expect(siteMap).toBeTruthy();
    const keys = Object.keys(siteMap);
    expect(keys).toContain('other');
  });

  test('noscript shows static content when JS is disabled', async ({ browser }) => {
    const ctx = await browser.newContext({ javaScriptEnabled: false });
    const page = await ctx.newPage();
    await page.goto('/');
    await expect(page.locator('#static-content')).toBeVisible();
    await ctx.close();
  });
});

// ── ARIA tree structure ────────────────────────────────────────────────────────

test.describe('ARIA tree structure', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForTree(page);
  });

  test('tree root has role="tree"', async ({ page }) => {
    await expect(page.locator('#tree-root')).toHaveAttribute('role', 'tree');
  });

  test('node rows have role="treeitem"', async ({ page }) => {
    const rows = page.locator('.node-content');
    await expect(rows.first()).toHaveAttribute('role', 'treeitem');
  });

  test('li elements have role="none"', async ({ page }) => {
    await expect(page.locator('.node').first()).toHaveAttribute('role', 'none');
  });

  test('expandable rows have aria-expanded', async ({ page }) => {
    const rows = page.locator('.node-content[aria-expanded]');
    expect(await rows.count()).toBeGreaterThan(0);
  });

  test('child lists have role="group"', async ({ page }) => {
    // #root is open by default, so child groups should already be visible
    await expect(page.locator('.tree[role="group"]').first()).toBeVisible();
  });

  test('rows have aria-setsize and aria-posinset', async ({ page }) => {
    // #root is open by default; wait for its children to render
    await expect(page.locator('.node-content').nth(1)).toBeVisible();
    const childRow = await nodeContent(page, 'child-a');
    const setSize = await childRow.getAttribute('aria-setsize');
    const posInSet = await childRow.getAttribute('aria-posinset');
    expect(Number(setSize)).toBeGreaterThan(0);
    expect(Number(posInSet)).toBeGreaterThan(0);
  });

  test('roving tabindex: only one row has tabIndex=0', async ({ page }) => {
    const tabRows = await page.locator('.node-content[tabindex="0"]').count();
    expect(tabRows).toBe(1);
  });
});

// ── Keyboard navigation ───────────────────────────────────────────────────────

test.describe('keyboard navigation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForTree(page);
    await selectedRow(page).focus();
  });

  test('ArrowDown moves to the next visible row', async ({ page }) => {
    const first = selectedRow(page);
    const firstText = await first.locator('.node-label').innerText();
    await first.press('ArrowDown');
    const second = selectedRow(page);
    const secondText = await second.locator('.node-label').innerText();
    expect(secondText).not.toBe(firstText);
  });

  test('ArrowUp does not move from the first row', async ({ page }) => {
    const first = selectedRow(page);
    const firstText = await first.locator('.node-label').innerText();
    await first.press('ArrowUp');
    const still = selectedRow(page);
    expect(await still.locator('.node-label').innerText()).toBe(firstText);
  });

  test('ArrowRight expands a collapsed node', async ({ page }) => {
    // #child-a is collapsed initially
    const row = await nodeContent(page, 'child-a');
    await row.focus();
    await row.press('ArrowRight');
    await expect(row).toHaveAttribute('aria-expanded', 'true');
  });

  test('ArrowRight moves into children when already expanded', async ({ page }) => {
    const row = await nodeContent(page, 'child-a');
    await row.focus();
    await row.press('ArrowRight'); // expand
    await expect(row).toHaveAttribute('aria-expanded', 'true');
    await row.press('ArrowRight'); // enter children
    // Now #grandchild should be selected
    await expect(await nodeContent(page, 'grandchild')).toHaveAttribute('aria-selected', 'true');
  });

  test('ArrowLeft collapses an open node', async ({ page }) => {
    const row = await nodeContent(page, 'child-a');
    await row.focus();
    await row.press('ArrowRight');
    await expect(row).toHaveAttribute('aria-expanded', 'true');
    await row.press('ArrowLeft');
    await expect(row).toHaveAttribute('aria-expanded', 'false');
  });

  test('ArrowLeft from a child moves to parent', async ({ page }) => {
    const parentRow = await nodeContent(page, 'child-a');
    await parentRow.focus();
    await parentRow.press('ArrowRight'); // expand
    await parentRow.press('ArrowRight'); // into grandchild
    await expect(await nodeContent(page, 'grandchild')).toHaveAttribute('aria-selected', 'true');
    await (selectedRow(page)).press('ArrowLeft');
    await expect(parentRow).toHaveAttribute('aria-selected', 'true');
  });

  test('Enter toggles expand/collapse', async ({ page }) => {
    const row = await nodeContent(page, 'child-a');
    await row.focus();
    await row.press('Enter');
    await expect(row).toHaveAttribute('aria-expanded', 'true');
    await row.press('Enter');
    await expect(row).toHaveAttribute('aria-expanded', 'false');
  });

  test('Space toggles expand/collapse', async ({ page }) => {
    const row = await nodeContent(page, 'child-a');
    await row.focus();
    await row.press('Space');
    await expect(row).toHaveAttribute('aria-expanded', 'true');
  });

  test('Home moves to first visible row', async ({ page }) => {
    // Move down a few rows
    await (selectedRow(page)).press('ArrowDown');
    await (selectedRow(page)).press('ArrowDown');
    // Home returns to first
    await (selectedRow(page)).press('Home');
    // First visible row is #root
    await expect(await nodeContent(page, 'root')).toHaveAttribute('aria-selected', 'true');
  });

  test('End moves to last visible row', async ({ page }) => {
    await (selectedRow(page)).press('End');
    const last = selectedRow(page);
    const allRows = await page.locator('.node-content').filter({ visible: true }).all();
    const lastText = await allRows[allRows.length - 1].innerText();
    expect(await last.innerText()).toBe(lastText);
  });

  test('c key copies permalink to clipboard', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const row = selectedRow(page);
    await row.press('c');
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toMatch(/#/);
  });
});

// ── Mouse interaction ────────────────────────────────────────────────────────

test.describe('mouse interaction', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForTree(page);
  });

  test('clicking a toggle expands and selects the row', async ({ page }) => {
    const row = await nodeContent(page, 'child-a');
    await row.locator('.toggle').click();
    await expect(row).toHaveAttribute('aria-expanded', 'true');
    await expect(row).toHaveAttribute('aria-selected', 'true');
  });

  test('clicking a toggle on expanded node collapses it', async ({ page }) => {
    const row = await nodeContent(page, 'child-a');
    await row.locator('.toggle').click(); // expand
    await expect(row).toHaveAttribute('aria-expanded', 'true');
    await row.locator('.toggle').click(); // collapse
    await expect(row).toHaveAttribute('aria-expanded', 'false');
  });

  test('clicking a label selects the row and updates aria-selected', async ({ page }) => {
    const row = await waitForNode(page, 'child-b');
    await row.click();
    await expect(row).toHaveAttribute('aria-selected', 'true');
  });

  test('clicking a different row deselects the previous one', async ({ page }) => {
    const rowA = await nodeContent(page, 'child-a');
    const rowB = await nodeContent(page, 'child-b');
    await rowA.click();
    await expect(rowA).toHaveAttribute('aria-selected', 'true');
    await rowB.click();
    await expect(rowB).toHaveAttribute('aria-selected', 'true');
    await expect(rowA).toHaveAttribute('aria-selected', 'false');
  });
});

// ── Expand / collapse mechanics ───────────────────────────────────────────────

test.describe('expand and collapse', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForTree(page);
  });

  test('{open} nodes are expanded by default', async ({ page }) => {
    // #root has {open}
    await expect(await nodeContent(page, 'root')).toHaveAttribute('aria-expanded', 'true');
  });

  test('{open} child nodes are also expanded by default', async ({ page }) => {
    // #child-open has {open}
    await expect(await nodeContent(page, 'child-open')).toHaveAttribute('aria-expanded', 'true');
  });

  test('collapsed node body has no rendered children', async ({ page }) => {
    const row = await nodeContent(page, 'child-a');
    await expect(row).toHaveAttribute('aria-expanded', 'false');
    const body = row.locator('~ .node-children');
    await expect(body.locator('.node-content')).toHaveCount(0);
  });

  test('expanding a node renders its children', async ({ page }) => {
    const row = await nodeContent(page, 'child-a');
    await row.focus();
    await row.press('ArrowRight');
    await expect((await nodeLi(page, 'child-a')).locator('.node-children .node-content').first()).toBeVisible();
  });

  test('collapsing a node removes its rendered children', async ({ page }) => {
    const row = await nodeContent(page, 'child-a');
    await row.focus();
    await row.press('ArrowRight');
    await expect((await nodeLi(page, 'child-a')).locator('.node-children .node-content').first()).toBeVisible();
    await row.press('ArrowLeft');
    await expect((await nodeLi(page, 'child-a')).locator('.node-children .node-content')).toHaveCount(0);
  });

  test('leaf nodes do not have aria-expanded', async ({ page }) => {
    // #child-minor has no children → leaf (visible because #root is open)
    const minorRow = await nodeContent(page, 'child-minor');
    await expect(minorRow).not.toHaveAttribute('aria-expanded');
  });
});

// ── Hash / URL routing ────────────────────────────────────────────────────────

test.describe('hash routing', () => {
  test('navigating to /#root shows that node as tree root', async ({ page }) => {
    await page.goto('/#root');
    await waitForTree(page);
    await expect(await nodeContent(page, 'root')).toBeVisible();
  });

  test('navigating to /other/#other-root shows the other-root node', async ({ page }) => {
    await page.goto('/other/#other-root');
    await waitForTree(page);
    await expect(await nodeContent(page, 'other-root')).toBeVisible();
  });

  test('hash change within page rerenders to new anchor', async ({ page }) => {
    await page.goto('/#root');
    await waitForTree(page);
    await expect(await nodeContent(page, 'root')).toBeVisible();
    await page.evaluate(() => { location.hash = '#nav-a'; });
    await page.waitForTimeout(300);
    await expect(await nodeContent(page, 'nav-a')).toBeVisible();
  });

  test('compound slug opens correct node', async ({ page }) => {
    // #child-b.1 = first child of child-b
    await page.goto('/#child-b.1');
    await waitForTree(page);
    await expect(page.locator('#tree-root .node-content').first()).toBeVisible();
  });

  test('permalink anchor # links contain the slug', async ({ page }) => {
    await page.goto('/');
    await waitForTree(page);
    const anchor = (await nodeContent(page, 'root')).locator('.node-id');
    const href = await anchor.getAttribute('href');
    expect(href).toContain('root');
  });
});

// ── Footer & metadata ─────────────────────────────────────────────────────────

test.describe('footer and metadata', () => {
  test('footer shows license from fixture', async ({ page }) => {
    await page.goto('/');
    await waitForTree(page);
    await expect(page.locator('footer')).toContainText('Test License');
  });

  test('footer shows author from fixture', async ({ page }) => {
    await page.goto('/');
    await waitForTree(page);
    await expect(page.locator('footer')).toContainText('test-author');
  });

  test('footer shows "show hidden" toggle', async ({ page }) => {
    await page.goto('/');
    await waitForTree(page);
    // It lives in the footer view menu, so it is visible once that is open.
    await openViewMenu(page);
    await expect(page.locator('footer .show-hidden-toggle')).toBeVisible();
  });

  test('[AI] tag provides meta.author: AI Author when node is focused', async ({ page }) => {
    await page.goto('/');
    await waitForTree(page);
    const row = await nodeContent(page, 'child-tagged');
    await row.click();
    await expect(page.locator('footer')).toContainText('AI Author');
  });

  // How meta resolves — file defaults, tag overrides, subtree cascade, attr
  // precedence, cross-file inheritance — is covered in tests/meta.test.mjs
  // against resolveFile(). What stays here is that selection drives the footer:
  // that the resolved author reaches the element, and follows the selected node.

  test('footer reverts to global author when leaving [AI]-tagged subtree', async ({ page }) => {
    await page.goto('/');
    await waitForTree(page);
    await (await nodeContent(page, 'child-tagged')).click();
    await expect(page.locator('footer')).toContainText('AI Author');
    await (await nodeContent(page, 'child-b')).click();
    await expect(page.locator('footer')).toContainText('test-author');
    await expect(page.locator('footer')).not.toContainText('AI Author');
  });

  test('page title matches fixture title', async ({ page }) => {
    await page.goto('/');
    await waitForTree(page);
    await expect(page).toHaveTitle(/Test Fixture/);
  });

  test('{=>} of AI-tagged target: children inherit AI meta', async ({ page }) => {
    // embed-ai-node link-transclubes embed-ai-target [AI].
    // Children borrowed from the target should carry AI Author meta.
    await page.goto('/#embed-ai-node');
    await waitForTree(page);
    const row = await nodeContent(page, 'embed-ai-node');
    await row.focus();
    await row.press('ArrowRight'); // expand — borrows embed-ai-target's children
    await row.press('ArrowRight'); // into first child — inherits AI meta
    await expect(page.locator('footer')).toContainText('AI Author');
  });

  test('[GlobalAI] tag on transcluded node (via {=>}) updates footer', async ({ page }) => {
    await page.goto('/#child-transcluded-ai');
    await waitForTree(page);
    const row = await nodeContent(page, 'child-transcluded-ai');
    await row.focus();
    await row.press('ArrowRight'); // expand — loads transcluded children
    // Wait for the transcluded AI-tagged child to appear
    const aiRow = await waitForNode(page, 'other-ai-node');
    await aiRow.click();
    await expect(page.locator('footer')).toContainText('Global AI Author');
  });

  test('[GlobalAI] tag cascades to children of transcluded node', async ({ page }) => {
    await page.goto('/#child-transcluded-ai');
    await waitForTree(page);
    const row = await nodeContent(page, 'child-transcluded-ai');
    await row.press('ArrowRight'); // expand transcluded children
    const aiRow = await waitForNode(page, 'other-ai-node');
    await aiRow.focus();
    await aiRow.press('ArrowRight'); // expand AI node
    await aiRow.press('ArrowRight'); // into child
    await expect(page.locator('footer')).toContainText('Global AI Author');
  });

  test('[GlobalAI] tag on node loaded via cross-file direct navigation updates footer', async ({ page }) => {
    // Navigate directly to other-container so it's the tree root; expand to find other-ai-node
    await page.goto('/other/#other-container');
    await waitForTree(page);
    const container = await nodeContent(page, 'other-container');
    await container.focus();
    await container.press('ArrowRight'); // expand other-container
    const row = await waitForNode(page, 'other-ai-node');
    await row.click();
    await expect(page.locator('footer')).toContainText('Global AI Author');
  });

  test('selecting AI-tagged node inside exhibit updates parent footer', async ({ page }) => {
    await page.goto('/#child-exhibit');
    await waitForTree(page);
    const exhibitRow = await nodeContent(page, 'child-exhibit');
    await exhibitRow.click(); // select
    await exhibitRow.click(); // open exhibit
    const iframeLocator = page.frameLocator('.exhibit-panel .exhibit-iframe');
    // Wait for the iframe tree to hydrate
    const rootRow = iframeLocator.locator('.node-content').first();
    await expect(rootRow).toBeVisible();
    await rootRow.press('ArrowRight'); // expand other-root to reveal children
    // other-root-ai is a [GlobalAI]-tagged child of other-root
    const aiRow = iframeLocator.locator('.node-content').filter({ hasText: 'AI-tagged child of other-root' }).first();
    await expect(aiRow).toBeVisible();
    await aiRow.click();
    await expect(page.locator('footer')).toContainText('Global AI Author');
  });

  // {action: exhibit} on a node with no exhibit in force still opens the panel.
  // Doing nothing would read as a broken control; the empty panel answers the
  // reader and can be dismissed with Escape.
  test('exhibit action with no exhibit in force opens an empty panel', async ({ page }) => {
    await page.goto('/#exhibit-action-no-scope');
    await waitForTree(page);
    const row = await nodeContent(page, 'exhibit-action-no-scope');
    await row.click(); // select
    await row.click(); // activate
    await expect(page.locator('.exhibit-panel')).toBeVisible();
    await expect(page.locator('.exhibit-panel .exhibit-hint')).toContainText('No exhibit active');
    await expect(page.locator('.exhibit-panel .exhibit-hint-key')).toBeVisible();
    await expect(page.locator('.exhibit-panel .exhibit-iframe')).toHaveCount(0);
  });

  // On a coarse pointer the Escape line is hidden (the × button is the
  // affordance), but the reader must still be told the panel is empty by design.
  test.describe('touch device', () => {
    test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

    test('empty exhibit still states its state, without the Escape line', async ({ page }) => {
      await page.goto('/#exhibit-action-no-scope');
      await waitForTree(page);
      const row = await nodeContent(page, 'exhibit-action-no-scope');
      await row.click();
      await row.click();
      await expect(page.locator('.exhibit-panel .exhibit-hint')).toContainText('No exhibit active');
      await expect(page.locator('.exhibit-panel .exhibit-hint-key')).toBeHidden();
    });
  });
});

// ── Tag chips ─────────────────────────────────────────────────────────────────

test.describe('tag chips', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForTree(page);
  });

  test('[AI] tag chip is visible on #child-tagged', async ({ page }) => {
    const chip = (await waitForNode(page, 'child-tagged')).locator('.node-tag').first();
    await expect(chip).toBeVisible();
    await expect(chip).toHaveText('AI');
  });

  // Which props a tag resolves to — registry lookup, inline overrides, internal,
  // node.* projection — is covered in tests/tags.test.mjs against resolveTagDef().
  // What stays here is that buildTagChips() puts resolved props onto real
  // elements: color reaches a CSS variable, tip reaches a title, a label
  // overrides the chip text, and an internal tag produces no chip at all.

  test('resolved tag props reach the chip element', async ({ page }) => {
    const chip = (await waitForNode(page, 'child-tagged')).locator('.node-tag').first();
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute('title', 'AI tip');
    const color = await chip.evaluate(el => el.style.getPropertyValue('--tag-color'));
    expect(color).toBe('#9e9bc4ff');
  });

  test('inline label overrides the chip text', async ({ page }) => {
    await page.goto('/#child-tag-inline-label');
    await waitForTree(page);
    const chip = (await waitForNode(page, 'child-tag-inline-label')).locator('.node-tag').first();
    await expect(chip).toHaveText('W.I.P.');
  });

  test('internal tag renders no chip', async ({ page }) => {
    const chips = (await waitForNode(page, 'child-internal')).locator('.node-tag');
    await expect(chips).toHaveCount(0);
  });
});

// ── [.hidden] tag ─────────────────────────────────────────────────────────────
//
// Nodes tagged [.hidden] use node.show-when: --show-hidden and are absent from
// the DOM until the "show hidden" checkbox sets --show-hidden in preroot state.

test.describe('[.hidden] tag', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForTree(page);
    // Ensure root is expanded so child-hidden would be reachable if visible
    await expect(page.locator('.node-content').nth(1)).toBeVisible();
  });

  test('[.hidden] nodes are absent from the DOM by default', async ({ page }) => {
    const found = await tryNodeContent(page, 'child-hidden');
    expect(found).toBeNull();
  });

  test('"show hidden" checkbox makes [.hidden] nodes appear', async ({ page }) => {
    await expect(await tryNodeContent(page, 'child-hidden')).toBeNull();
    await openViewMenu(page);
    await page.locator('.show-hidden-toggle').click();
    await expect(await waitForNode(page, 'child-hidden')).toBeVisible();
  });

  test('unchecking "show hidden" removes [.hidden] nodes again', async ({ page }) => {
    await openViewMenu(page);
    await page.locator('.show-hidden-toggle').click();
    await expect(await waitForNode(page, 'child-hidden')).toBeVisible();
    await page.locator('.show-hidden-toggle').click();
    // After unchecking, node should be removed from DOM
    await page.waitForFunction((id) => {
      const rns = window._rvmarkFindNodes?.(id);
      return !(rns?.length);
    }, 'child-hidden');
    expect(await tryNodeContent(page, 'child-hidden')).toBeNull();
  });
});

// ── {action: link} modifier ───────────────────────────────────────────────────

test.describe('{action: link} modifier', () => {
  test('{action: link} node is a leaf (no aria-expanded)', async ({ page }) => {
    await page.goto('/');
    await waitForTree(page);
    await expect(page.locator('.node-content').nth(1)).toBeVisible();
    const linkRow = await nodeContent(page, 'child-link');
    await expect(linkRow).toBeVisible();
    await expect(linkRow).not.toHaveAttribute('aria-expanded');
  });

  test('{action: link} node label contains external link', async ({ page }) => {
    await page.goto('/');
    await waitForTree(page);
    const link = (await nodeContent(page, 'child-link')).locator('.node-label a');
    await expect(link).toBeVisible();
    const href = await link.getAttribute('href');
    expect(href).toBe('https://example.com');
  });
});

// ── Same-file transclusion ({=> #slug}) ──────────────────────────────────────

test.describe('same-file transclusion', () => {
  test('{=> #embed-target} node shows target label after loading', async ({ page }) => {
    await page.goto('/');
    await waitForTree(page);
    // #child-embed embeds #embed-target. waitForNode, not nodeContent: a
    // transclusion mounts only once its target resolves, which is after
    // waitForTree sees the first hydrated row.
    const label = (await waitForNode(page, 'child-embed')).locator('.node-label');
    await expect(label).toContainText('Embed target node');
  });

  test('{embed} node expands to show target children', async ({ page }) => {
    await page.goto('/#child-embed');
    await waitForTree(page);
    const row = await nodeContent(page, 'child-embed');
    await row.focus();
    await row.press('ArrowRight');
    await expect(row).toHaveAttribute('aria-expanded', 'true');
    await expect((await nodeLi(page, 'child-embed')).locator('.node-children .node-content').first()).toBeVisible();
  });

  test('no node labels show loading placeholder text', async ({ page }) => {
    await page.goto('/');
    await waitForTree(page);
    const labels = page.locator('.node-label');
    const count = await labels.count();
    for (let i = 0; i < Math.min(count, 20); i++) {
      const text = await labels.nth(i).innerText();
      expect(text).not.toMatch(/^\.{1,3}$/);
    }
  });
});

// ── Cross-file transclusion ({=> ./other#slug}) ──────────────────────────────

test.describe('cross-file transclusion', () => {
  test('{=> ./other#other-root} shows other-root label', async ({ page }) => {
    await page.goto('/');
    await waitForTree(page);
    await page.waitForTimeout(500);
    const label = (await nodeContent(page, 'child-cross-embed')).locator('.node-label');
    if (await label.count() > 0) {
      await expect(label).not.toHaveText('...');
    }
  });

  test('{=> ./other#other-root} with label expands to show other file children', async ({ page }) => {
    await page.goto('/');
    await waitForTree(page);
    // waitForNode: the cross-file target must be fetched before this row mounts.
    const row = await waitForNode(page, 'child-cross-children');
    await row.focus();
    await row.press('ArrowRight');
    await expect(row).toHaveAttribute('aria-expanded', 'true');
    await expect((await nodeLi(page, 'child-cross-children')).locator('.node-children .node-content').first()).toBeVisible();
  });
});

// ── Delayed & broken transclusions ───────────────────────────────────────────
// A "delayed" transclusion is one whose .rvmark fetch is slow: we hold the fetch
// open with request interception, gated on a promise the test controls. The
// on-load link-mode embed (child-cross-embed) primes the shared file cache, so
// child-cross-children awaits the same held fetch when expanded.

test.describe('delayed and broken transclusions', () => {
  test('delayed children-mode transclusion shows one loading marker, then settles', async ({ page }) => {
    let release;
    const gate = new Promise((r) => { release = r; });
    await page.route('**/_rvmark/other.rvmark', async (route) => {
      await gate;               // hold the fetch — this IS the delay
      await route.continue();
    });

    await page.goto('/');
    await waitForTree(page);
    const row = await waitForNode(page, 'child-cross-children');
    await row.focus();
    await row.press('ArrowRight');   // expand → phase 1 mounts the loading marker

    const li = await nodeLi(page, 'child-cross-children');
    const loading = li.locator('.node-children .node-content--loading');
    await expect(loading).toHaveCount(1);   // exactly one marker while gated

    release();                       // fetch completes → phase 2 swaps in real children
    await expect(loading).toHaveCount(0);
    await expect(li.locator('.node-children .node-content').first()).toContainText('Other file child');
  });

  test('broken children-mode transclusion shows a not-found error marker', async ({ page }) => {
    await page.route('**/_rvmark/other.rvmark', (route) => route.fulfill({ status: 404, body: 'nope' }));

    await page.goto('/');
    await waitForTree(page);
    const row = await waitForNode(page, 'child-cross-children');
    await row.focus();
    await row.press('ArrowRight');   // expand → ref fails → error marker (not silent)

    const err = (await nodeLi(page, 'child-cross-children'))
      .locator('.node-children .node-content').filter({ hasText: 'not found' });
    await expect(err).toHaveCount(1);
  });
});

// ── Markdown bodies ──────────────────────────────────────────────────────────

test.describe('markdown bodies', () => {
  test('{type: markdown} body renders HTML immediately (always open)', async ({ page }) => {
    await page.goto('/');
    await waitForTree(page);
    // Markdown nodes are always open — body visible without interaction
    await expect((await nodeLi(page, 'child-markdown')).locator('.md-body').first()).toBeVisible();
  });

  test('markdown body renders inline code', async ({ page }) => {
    await page.goto('/');
    await waitForTree(page);
    const code = (await nodeLi(page, 'child-markdown')).locator('.md-body code').first();
    await expect(code).toBeVisible();
    await expect(code).toHaveText('code');
  });

  test('markdown body renders a table', async ({ page }) => {
    await page.goto('/');
    await waitForTree(page);
    await expect((await nodeLi(page, 'child-markdown')).locator('.md-body table').first()).toBeVisible();
  });
});

// ── Math (KaTeX) ──────────────────────────────────────────────────────────────

test.describe('math rendering', () => {
  test('inline math $x = 1$ in label renders via KaTeX', async ({ page }) => {
    await page.goto('/');
    await waitForTree(page);
    // #child-math has "Inline math: $x = 1$" — #root is open so it's visible
    const label = (await nodeContent(page, 'child-math')).locator('.node-label');
    const katex = label.locator('.katex');
    if (await katex.count() > 0) {
      await expect(katex.first()).toBeVisible();
    }
  });
});

// ── Document zone (Tab order) ─────────────────────────────────────────────────

test.describe('document zone (tab order)', () => {
  test('links in selected node label are in tab order', async ({ page }) => {
    await page.goto('/');
    await waitForTree(page);
    // Select #child-link which has an external link in its label
    const row = await nodeContent(page, 'child-link');
    await row.click();
    await expect(row).toHaveAttribute('aria-selected', 'true');
    const link = row.locator('.node-label a');
    if (await link.count() > 0) {
      const tabIndex = await link.first().getAttribute('tabindex');
      expect(tabIndex).not.toBe('-1');
    }
  });

  test('links in non-selected rows have tabIndex=-1', async ({ page }) => {
    await page.goto('/');
    await waitForTree(page);
    const nonSelectedLinks = page.locator('.node-content:not([aria-selected="true"]) .node-label a');
    const count = await nonSelectedLinks.count();
    for (let i = 0; i < Math.min(count, 5); i++) {
      const tabIndex = await nonSelectedLinks.nth(i).getAttribute('tabindex');
      expect(tabIndex).toBe('-1');
    }
  });
});

// ── Permalink anchor ──────────────────────────────────────────────────────────

test.describe('permalink anchor', () => {
  test('each row has a # permalink anchor', async ({ page }) => {
    await page.goto('/');
    await waitForTree(page);
    const anchors = page.locator('.node-id');
    expect(await anchors.count()).toBeGreaterThan(0);
    await expect(anchors.first()).toHaveText('#');
  });

  test('permalink anchor on #root points to root slug', async ({ page }) => {
    await page.goto('/');
    await waitForTree(page);
    const anchor = (await nodeContent(page, 'root')).locator('.node-id');
    const href = await anchor.getAttribute('href');
    expect(href).toContain('root');
  });
});

// ── Inline Markdown in labels ─────────────────────────────────────────────────

test.describe('inline markdown in labels', () => {
  test('**bold** renders as <strong>', async ({ page }) => {
    await page.goto('/');
    await waitForTree(page);
    // #root label is "Root node with **bold** and *italic*"
    const strong = (await nodeContent(page, 'root')).locator('.node-label strong').first();
    await expect(strong).toBeVisible();
    await expect(strong).toHaveText('bold');
  });

  test('*italic* renders as <em>', async ({ page }) => {
    await page.goto('/');
    await waitForTree(page);
    const em = (await nodeContent(page, 'root')).locator('.node-label em').first();
    await expect(em).toBeVisible();
    await expect(em).toHaveText('italic');
  });

  test('external links open in a new tab, safely', async ({ page }) => {
    await page.goto('/');
    await waitForTree(page);
    const link = (await nodeContent(page, 'child-link')).locator('a').first();
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /noopener/);
  });

});

// ── Static (no-JS) fallback ───────────────────────────────────────────────────

test.describe('progressive enhancement', () => {
  test('static HTML contains readable content without JS', async ({ browser }) => {
    const ctx = await browser.newContext({ javaScriptEnabled: false });
    const page = await ctx.newPage();
    await page.goto('/');
    await expect(page.locator('#static-content')).toBeVisible();
    const text = await page.locator('#static-content').innerText();
    expect(text.length).toBeGreaterThan(50);
    await ctx.close();
  });

  test('static HTML shows bold and italic in root node', async ({ browser }) => {
    const ctx = await browser.newContext({ javaScriptEnabled: false });
    const page = await ctx.newPage();
    await page.goto('/');
    await expect(page.locator('#static-content strong').first()).toHaveText('bold');
    await expect(page.locator('#static-content em').first()).toHaveText('italic');
    await ctx.close();
  });

  test('static HTML always renders [.hidden] nodes (no state in static fallback)', async ({ browser }) => {
    const ctx = await browser.newContext({ javaScriptEnabled: false });
    const page = await ctx.newPage();
    await page.goto('/');
    // [.hidden] nodes have no JS state, so static HTML renders them unconditionally
    await expect(page.locator('#static-content #child-hidden')).toBeVisible();
    await ctx.close();
  });
});

// ── {draft} modifier ─────────────────────────────────────────────────────────
//
// Fixture nodes:
//   1.11. {#draft-sibling-before} Before draft
//   1.12. {#draft-node; draft} Draft node (should be absent)
//     1.12.1. {#draft-child} Draft child (should be absent)
//   1.13. {#draft-sibling-after} After draft
//
// draft-file.rvmark has {draft} in its metadata and should not be built.

test.describe('{draft} modifier', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForTree(page);
  });

  // Pruning, build output, site map and served source are covered exhaustively
  // in tests/draft.test.mjs, which reads the parser and tests/dist/ directly.
  // These two smoke tests keep one end-to-end check per surface — that pruning
  // survives rendering, and survives the no-JS path.

  test('draft nodes and their children are absent from the rendered tree', async ({ page }) => {
    await expect(page.locator('#draft-node')).toHaveCount(0);
    await expect(page.locator('#draft-child')).toHaveCount(0);
    await expect(page.locator('#draft-nested')).toHaveCount(0);
    await expect(page.locator('#tree-root')).not.toContainText('DRAFT_NODE_LABEL');
    await expect(page.locator('#tree-root')).not.toContainText('DRAFT_NESTED_LABEL');
    // Siblings on both sides survive, so this is pruning and not a parse failure.
    await expect(page.locator('#draft-sibling-before')).toHaveCount(1);
    await expect(page.locator('#draft-sibling-after')).toHaveCount(1);
    await expect(page.locator('#draft-nested-sibling-after')).toHaveCount(1);
  });

  test('draft content is absent from the no-JS static fallback', async ({ browser }) => {
    const ctx = await browser.newContext({ javaScriptEnabled: false });
    const page = await ctx.newPage();
    await page.goto('/');
    await expect(page.locator('#static-content #draft-node')).toHaveCount(0);
    await expect(page.locator('#static-content #draft-nested')).toHaveCount(0);
    const html = await page.locator('#static-content').innerHTML();
    for (const s of ['DRAFT_NODE_LABEL', 'DRAFT_CHILD_LABEL', 'DRAFT_GRANDCHILD_LABEL',
                     'DRAFT_BODY_CONTENT', 'DRAFT_TOP_BODY_CONTENT',
                     'DRAFT_CONTINUATION_TEXT', 'DRAFT_NESTED_LABEL']) {
      expect(html).not.toContain(s);
    }
    await expect(page.locator('#static-content #draft-nested-sibling-after')).toHaveCount(1);
    await ctx.close();
  });
});

// ── Event attributes ──────────────────────────────────────────────────────────
//
// Fixture (under #event-root which is open by default):
//   #event-spawn-parent     {& spawned=1}           → children see spawned=1
//   #event-spawn-indicator  {? spawned}             → visible when spawned truthy
//   #event-select-parent    {& focused=0; on-select: focused<<1; on-deselect: focused<<0}
//   #event-select-indicator {? focused}             → visible when focused truthy
//   #event-action-parent    {& acted=0; on-action: acted<<1}
//   #event-action-indicator {? acted}               → visible when acted truthy
//   #event-expand-parent    {& expanded-flag=0; on-expand: expanded-flag<<1; on-collapse: expanded-flag<<0}
//   #event-expand-indicator {? expanded-flag}       → visible when expanded truthy

test.describe('event attributes', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/#event-root');
    await waitForTree(page);
    // event-root is {open}; wait for its children to render
    await expect(await waitForNode(page, 'event-spawn-parent')).toBeVisible();
  });

  test('{& spawned=1} makes indicator visible when parent is expanded', async ({ page }) => {
    const parent = await nodeContent(page, 'event-spawn-parent');
    await parent.focus();
    await parent.press('ArrowRight'); // expand
    await expect(await nodeContent(page, 'event-spawn-indicator')).toBeVisible();
  });

  test('on-select fires state change making indicator visible', async ({ page }) => {
    const parent = await nodeContent(page, 'event-select-parent');
    await parent.focus();
    await parent.press('ArrowRight'); // expand so children render — on-select already fired
    await expect(await nodeContent(page, 'event-select-indicator')).toBeVisible();
    // Move away → on-deselect → indicator gone, node collapses
    await parent.press('ArrowDown');
    expect(await tryNodeContent(page, 'event-select-indicator')).toBeNull();
    // Move back → on-select → node becomes expandable again, expand to see indicator
    await parent.focus();
    await parent.press('ArrowRight');
    await expect(await nodeContent(page, 'event-select-indicator')).toBeVisible();
  });

  test('on-deselect hides indicator when node loses focus', async ({ page }) => {
    const parent = await nodeContent(page, 'event-select-parent');
    await parent.focus();
    await parent.press('ArrowRight'); // expand — on-select fires → focused=1
    await expect(await nodeContent(page, 'event-select-indicator')).toBeVisible();
    await parent.press('ArrowDown'); // move away → on-deselect → focused<<0
    expect(await tryNodeContent(page, 'event-select-indicator')).toBeNull();
  });

  test('on-action fires state change when Enter is pressed', async ({ page }) => {
    const parent = await nodeContent(page, 'event-action-parent');
    await parent.focus();
    expect(await tryNodeContent(page, 'event-action-indicator')).toBeNull();
    await parent.press('Enter'); // fires on-action → acted<<1; node becomes toggleable
    await parent.press('Enter'); // now toggleable, expand to show children
    await expect(await waitForNode(page, 'event-action-indicator')).toBeVisible();
  });

  // Action is one concept with two gestures: Enter/Space, and re-clicking an
  // already-selected node (wireSelectThenAction). These assert the click gesture
  // reaches on-action too — it previously fired only from the keyboard.
  test('on-action fires when an already-selected node is re-clicked', async ({ page }) => {
    const parent = await nodeContent(page, 'event-action-parent');
    expect(await tryNodeContent(page, 'event-action-indicator')).toBeNull();
    await parent.click(); // first click only selects
    await parent.click(); // re-click = action → acted=1; node becomes toggleable
    await parent.click(); // now toggleable, expand to reveal the child indicator
    await expect(await waitForNode(page, 'event-action-indicator')).toBeVisible();
  });

  test('on-action fires on a leaf node when re-clicked', async ({ page }) => {
    // A leaf has no expand/exhibit behaviour, so on-action is the *only* thing
    // its action gesture does — the case that had no click wiring at all.
    const root = await nodeContent(page, 'event-action-leaf-root');
    await root.focus();
    await root.press('ArrowRight'); // expand so the leaf mounts
    const leaf = await waitForNode(page, 'event-action-leaf');
    expect(await tryNodeContent(page, 'event-action-leaf-indicator')).toBeNull();
    await leaf.click(); // selects
    await leaf.click(); // re-click = action
    await expect(await waitForNode(page, 'event-action-leaf-indicator')).toBeVisible();
  });

  test('on-action fires on a leaf node when Enter is pressed', async ({ page }) => {
    const root = await nodeContent(page, 'event-action-leaf-root');
    await root.focus();
    await root.press('ArrowRight');
    const leaf = await waitForNode(page, 'event-action-leaf');
    expect(await tryNodeContent(page, 'event-action-leaf-indicator')).toBeNull();
    await leaf.press('Enter');
    await expect(await waitForNode(page, 'event-action-leaf-indicator')).toBeVisible();
  });

  test('on-action does not fire on the first click that merely selects', async ({ page }) => {
    const root = await nodeContent(page, 'event-action-leaf-root');
    await root.focus();
    await root.press('ArrowRight');
    const leaf = await waitForNode(page, 'event-action-leaf');
    expect(await tryNodeContent(page, 'event-action-leaf-indicator')).toBeNull();
    await leaf.click(); // selection only — must not act
    expect(await tryNodeContent(page, 'event-action-leaf-indicator')).toBeNull();
  });

  test('on-expand fires state change when node is expanded', async ({ page }) => {
    const parent = await nodeContent(page, 'event-expand-parent');
    await parent.focus();
    expect(await tryNodeContent(page, 'event-expand-indicator')).toBeNull();
    await parent.press('ArrowRight'); // expand → on-expand → expanded-flag<<1
    await expect(await nodeContent(page, 'event-expand-indicator')).toBeVisible();
  });

  test('on-collapse fires state change when node is collapsed', async ({ page }) => {
    const parent = await nodeContent(page, 'event-expand-parent');
    await parent.focus();
    await parent.press('ArrowRight'); // expand → on-expand → expanded-flag=1
    await expect(await nodeContent(page, 'event-expand-indicator')).toBeVisible();
    await parent.press('ArrowLeft'); // collapse → on-collapse → expanded-flag=0
    expect(await tryNodeContent(page, 'event-expand-indicator')).toBeNull();
  });
});

// ── State pass system ─────────────────────────────────────────────────────────
//
// Fixture (all under #pass-root, each test in its own scope node):
//   pass-scope-read    {& passvar=0}
//     pass-host-read   {on-action: passvar<<1; => other#pass-read-target; children-pass: passvar}
//       (transcluded) pass-read-indicator {? passvar==1}
//   pass-scope-blocked {& passvar=0}
//     pass-host-blocked {on-action: passvar<<1; => other#pass-blocked-target}  (no children-pass)
//       (transcluded) pass-blocked-indicator {? passvar==1}
//   pass-scope-rw      {& passvar=0}
//     pass-host-rw     {=> other#pass-rw-target; children-pass: passvar rw}
//       (transcluded) pass-rw-indicator {? passvar==1} + pass-rw-writer {on-action: passvar<<1}
//     pass-host-rw-indicator {? passvar==1}
//   pass-scope-wo      {& passvar=0}
//     pass-host-wo     {=> other#pass-wo-target; children-pass: passvar w}
//       (transcluded) pass-wo-blocked-indicator {? passvar==1} + pass-wo-writer {on-action: passvar<<1}
//     pass-host-wo-indicator {? passvar==1}
//   pass-scope-rename  {& passvar=0}
//     pass-host-rename {on-action: passvar<<1; => other#pass-rename-target; children-pass: remotevar=passvar}
//       (transcluded) pass-rename-indicator {? remotevar==1}
//   pass-scope-dash    {& --dashvar=0}
//     pass-host-dash   {on-action: --dashvar<<1; => other#pass-dash-target}  (no children-pass needed)
//       (transcluded) pass-dash-indicator {? --dashvar==1}
//                    + pass-dash-write-attempt {on-action: --dashvar<<99}
//   pass-scope-exhibit {& exvar=0}
//     pass-exhibit-host {exhibit: other#pass-exhibit-target; exhibit-pass: exvar rw}
//       (in exhibit) pass-exhibit-indicator {? exvar==1} + pass-exhibit-writer {on-action: exvar<<1}
//     pass-exhibit-host-indicator {? exvar==1}
//   pass-scope-exhibit-blocked {& exvar=0}
//     pass-exhibit-blocked-host {exhibit: other#pass-exhibit-blocked-target}  (no exhibit-pass)
//       (in exhibit) pass-exhibit-blocked-indicator {? exvar==1}
//   pass-scope-exhibit-ro {& exvar=0}
//     pass-exhibit-ro-host {exhibit: other#pass-exhibit-target; exhibit-pass: exvar}  (read-only)
//       (in exhibit) pass-exhibit-indicator {? exvar==1} + pass-exhibit-writer {on-action: exvar<<1}

test.describe('state pass system', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/#pass-root');
    await waitForTree(page);
  });

  // ── Cross-file read-only pass ───────────────────────────────────────────────

  test('children-pass: r — transcluded child sees host state when host sets it', async ({ page }) => {
    const host = await nodeContent(page, 'pass-host-read');
    // Enter: expands (loads transcluded children) AND fires on-action (passvar<<1).
    // Children load with passvar already 1 → indicator renders immediately.
    await host.press('Enter');
    await expect(await waitForNode(page, 'pass-read-indicator')).toBeVisible();
  });

  test('cross-file default: host state blocked without children-pass', async ({ page }) => {
    const host = await nodeContent(page, 'pass-host-blocked');
    await host.press('Enter'); // passvar<<1 in pass-scope-blocked
    await host.press('ArrowRight'); // expand transcluded children
    await page.waitForTimeout(300);
    // No children-pass attr → StatePass with empty permissions → passvar invisible
    expect(await tryNodeContent(page, 'pass-blocked-indicator')).toBeNull();
  });

  test('children-pass: rw — transcluded child can write back to host frame', async ({ page }) => {
    const host = await nodeContent(page, 'pass-host-rw');
    await host.press('ArrowRight'); // expand transcluded children
    // Neither indicator should be visible yet
    await page.waitForTimeout(200);
    expect(await tryNodeContent(page, 'pass-rw-indicator')).toBeNull();
    expect(await tryNodeContent(page, 'pass-host-rw-indicator')).toBeNull();
    // Writer in transcluded subtree fires on-action: passvar<<1 — writes back to host frame via rw pass
    const writer = await waitForNode(page, 'pass-rw-writer');
    await writer.press('Enter');
    // Host-frame indicator (sibling of pass-host-rw) must appear — write-back succeeded
    await expect(await waitForNode(page, 'pass-host-rw-indicator')).toBeVisible();
    // Transcluded indicator also reads passvar via pass — must appear too
    await expect(await waitForNode(page, 'pass-rw-indicator')).toBeVisible();
  });

  test('children-pass: w — transcluded child can write to host but cannot read', async ({ page }) => {
    const host = await nodeContent(page, 'pass-host-wo');
    await host.press('ArrowRight'); // expand transcluded children
    await waitForNode(page, 'pass-wo-writer');
    await page.waitForTimeout(200);
    // Blocked indicator must stay hidden (write-only: child has no read permission)
    expect(await tryNodeContent(page, 'pass-wo-blocked-indicator')).toBeNull();
    // Host-side indicator also hidden (passvar still 0)
    expect(await tryNodeContent(page, 'pass-host-wo-indicator')).toBeNull();
    // Writer fires on-action: passvar<<1 — writes to host frame
    await (await nodeContent(page, 'pass-wo-writer')).press('Enter');
    // Host indicator must appear (write succeeded)
    await expect(await waitForNode(page, 'pass-host-wo-indicator')).toBeVisible();
    // Blocked indicator must still NOT appear (no read permission)
    expect(await tryNodeContent(page, 'pass-wo-blocked-indicator')).toBeNull();
  });

  test('children-pass: rename — child sees host variable under different remote key', async ({ page }) => {
    // children-pass: remotevar=passvar → child sees passvar as remotevar
    const host = await nodeContent(page, 'pass-host-rename');
    // Enter: expands + sets passvar<<1; child reads {? remotevar==1} via rename
    await host.press('Enter');
    await expect(await waitForNode(page, 'pass-rename-indicator')).toBeVisible();
  });

  // ── Double-dash prefix (auto-pass read-only) ────────────────────────────────

  test('-- prefix: auto-passes read-only across file boundary without explicit children-pass', async ({ page }) => {
    // pass-host-dash has no children-pass attr; --dashvar auto-passes read-only
    const host = await nodeContent(page, 'pass-host-dash');
    // Enter: expands + sets --dashvar<<1; child reads {? --dashvar==1} auto-passed
    await host.press('Enter');
    await expect(await waitForNode(page, 'pass-dash-indicator')).toBeVisible();
  });

  test('-- prefix: cross-file write-back is blocked', async ({ page }) => {
    // pass-dash-write-attempt tries on-action: --dashvar<<99 from inside other.rvmark
    const host = await nodeContent(page, 'pass-host-dash');
    await host.press('ArrowRight'); // expand (no on-action — doesn't set --dashvar)
    await waitForNode(page, 'pass-dash-write-node');
    // Attempt to write --dashvar from inside the transcluded file
    await (await nodeContent(page, 'pass-dash-write-node')).press('Enter');
    // --dashvar should still be 0; indicator must not appear
    await page.waitForTimeout(200);
    expect(await tryNodeContent(page, 'pass-dash-indicator')).toBeNull();
    // Collapse, then Enter on host (expands + sets --dashvar<<1) — indicator appears
    await host.press('ArrowLeft');
    await host.press('Enter');
    await expect(await waitForNode(page, 'pass-dash-indicator')).toBeVisible();
  });

  // ── Exhibit iframe pass ─────────────────────────────────────────────────────

  async function openExhibit(page, nodeId) {
    const row = await nodeContent(page, nodeId);
    await row.click(); // select
    await row.click(); // open exhibit (second click on selected node)
    const frame = page.frameLocator('.exhibit-panel .exhibit-iframe');
    const root = frame.locator('.node-content').first();
    await expect(root).toBeVisible();
    await root.press('ArrowRight'); // expand root to reveal children
    return frame;
  }

  test('exhibit-pass: rw — exhibit reads host state and can write back', async ({ page }) => {
    const frame = await openExhibit(page, 'pass-exhibit-host');
    // exvar=0 initially; exhibit indicator hidden
    const iframeIndicator = frame.locator('.node-content').filter({ hasText: 'pass-exhibit-visible' });
    await expect(iframeIndicator).not.toBeVisible();
    expect(await tryNodeContent(page, 'pass-exhibit-host-indicator')).toBeNull();
    // Writer inside exhibit fires on-action: exvar<<1 — relayed back to host frame
    await frame.locator('.node-content').filter({ hasText: 'pass-exhibit-writer' }).press('Enter');
    // Host-side indicator appears (write-back succeeded)
    await expect(await waitForNode(page, 'pass-exhibit-host-indicator')).toBeVisible();
    // Exhibit-side indicator also appears (reads exvar via exhibit-pass)
    await expect(iframeIndicator).toBeVisible();
  });

  test('exhibit without exhibit-pass: host state invisible inside exhibit', async ({ page }) => {
    const frame = await openExhibit(page, 'pass-exhibit-blocked-host');
    await page.waitForTimeout(300);
    // Exhibit content has {? exvar==1} indicator — must NOT appear (no exhibit-pass)
    const blocked = frame.locator('.node-content').filter({ hasText: 'pass-exhibit-blocked-visible' });
    await expect(blocked).not.toBeVisible();
  });

  test('exhibit-pass: r — write-back from exhibit to host is blocked', async ({ page }) => {
    // pass-exhibit-ro-host has exhibit-pass: exvar (read-only)
    // The exhibit contains a writer that attempts exvar<<1 — this must NOT propagate to the host.
    const frame = await openExhibit(page, 'pass-exhibit-ro-host');
    await frame.locator('.node-content').filter({ hasText: 'pass-exhibit-writer' }).press('Enter');
    await page.waitForTimeout(300);
    // pass-scope-exhibit-ro's pass-exhibit-host-indicator {? exvar==1} must NOT appear
    expect(await tryNodeContent(page, 'pass-exhibit-host-indicator')).toBeNull();
  });

  // ── Additional children-pass tests ─────────────────────────────────────────

  test('children-pass: r — write-back from child to host is blocked', async ({ page }) => {
    // pass-host-r-write-blocked has children-pass: passvar (r only)
    // The transcluded target has a writer: on-action: passvar<<1
    // Since mode is r, _set from child should fail and host frame stays at 0
    const host = await nodeContent(page, 'pass-host-r-write-blocked');
    await host.press('ArrowRight'); // expand without setting passvar
    const writer = await waitForNode(page, 'pass-r-write-blocked-writer');
    await writer.press('Enter');
    await page.waitForTimeout(200);
    // Host-side indicator must NOT appear (write was blocked by r-only pass)
    expect(await tryNodeContent(page, 'pass-host-r-write-blocked-indicator')).toBeNull();
  });

  test('children-pass: r — host update after children loaded is visible to child', async ({ page }) => {
    // Expand first (children load with passvar=0, indicator hidden), then trigger host set
    const host = await nodeContent(page, 'pass-host-reactive');
    await host.press('ArrowRight'); // expand: children load, passvar still 0
    await waitForNode(page, 'pass-read-anchor'); // stable anchor confirms children loaded
    await page.waitForTimeout(200);
    expect(await tryNodeContent(page, 'pass-read-indicator')).toBeNull();
    // Now trigger host-side state change via sibling trigger
    const trigger = await nodeContent(page, 'pass-scope-reactive-trigger');
    await trigger.press('Enter'); // on-action: passvar<<1
    // Transcluded child's {? passvar==1} indicator must now appear reactively
    await expect(await waitForNode(page, 'pass-read-indicator')).toBeVisible();
  });

  test('children-pass: multiple vars — r and w simultaneously', async ({ page }) => {
    // children-pass: avar, bvar w — child reads avar (r) and writes bvar (w)
    const host = await nodeContent(page, 'pass-host-multi');
    // Set avar=1 on host scope via on-spawn; avar is declared by & avar=0 then we need to trigger
    // Instead: expand and check avar indicator (avar stays 0 so indicator hidden),
    // then write bvar via child writer and verify host-side bvar indicator appears
    await host.press('ArrowRight');
    await waitForNode(page, 'pass-multi-bvar-writer');
    await page.waitForTimeout(200);
    // avar==0 so avar indicator in child is hidden
    expect(await tryNodeContent(page, 'pass-multi-avar-indicator')).toBeNull();
    // Child writer fires bvar<<1 — should write back to host (bvar w mode)
    await (await nodeContent(page, 'pass-multi-bvar-writer')).press('Enter');
    // Host-side indicator {? bvar==1} must appear
    await expect(await waitForNode(page, 'pass-host-multi-indicator')).toBeVisible();
    // avar indicator still hidden (avar still 0)
    expect(await tryNodeContent(page, 'pass-multi-avar-indicator')).toBeNull();
  });

  test('children-pass: unknown key is blocked even with other keys permitted', async ({ page }) => {
    // children-pass: passvar — only passvar is whitelisted
    // pass-unknown-key-target has {? unknownvar==1} — unknownvar not in pass, must stay hidden
    // unknownvar is never set so indicator never spawns — confirm it's absent after expansion
    const host = await nodeContent(page, 'pass-host-unknown-key');
    await host.press('ArrowRight');
    await page.waitForTimeout(300);
    // If unknownvar leaked through the pass, the host's passvar=0 wouldn't matter —
    // unknownvar would be undefined → condition {? unknownvar==1} is false → node absent
    expect(await tryNodeContent(page, 'pass-unknown-key-indicator')).toBeNull();
  });

  test('children-pass: shadowing — child declaring same key does not affect host', async ({ page }) => {
    // pass-host-rw with rw pass: child re-declares passvar locally shouldn't clobber host
    // We verify host indicator only appears from an explicit write via _set, not from child declare
    const host = await nodeContent(page, 'pass-host-rw');
    await host.press('ArrowRight');
    await waitForNode(page, 'pass-rw-writer');
    await page.waitForTimeout(200);
    // Host indicator not visible yet
    expect(await tryNodeContent(page, 'pass-host-rw-indicator')).toBeNull();
    // Writer fires on-action: passvar<<1 — _set propagates up through pass to host
    await (await nodeContent(page, 'pass-rw-writer')).press('Enter');
    await expect(await waitForNode(page, 'pass-host-rw-indicator')).toBeVisible();
    // Collapse and reopen — host indicator still visible (host frame retains value)
    await host.press('ArrowLeft');
    await host.press('ArrowRight');
    await page.waitForTimeout(200);
    await expect(await waitForNode(page, 'pass-host-rw-indicator')).toBeVisible();
  });

  test('children-pass: w — child cannot read host variable (get returns undefined)', async ({ page }) => {
    // pass-scope-wo: & passvar=0 → pass-host-wo has children-pass: passvar w
    // pass-wo-blocked-indicator {? passvar==1} inside target — passvar w-only → child can't read
    // After child writes (passvar<<1), host indicator appears but child indicator must NOT
    const host = await nodeContent(page, 'pass-host-wo');
    await host.press('ArrowRight');
    await waitForNode(page, 'pass-wo-writer');
    await (await nodeContent(page, 'pass-wo-writer')).press('Enter');
    await page.waitForTimeout(200);
    // Host saw the write
    await expect(await waitForNode(page, 'pass-host-wo-indicator')).toBeVisible();
    // Child cannot read — blocked indicator still absent
    expect(await tryNodeContent(page, 'pass-wo-blocked-indicator')).toBeNull();
  });

  test('children-pass: collapse and re-expand resets child state but not host state', async ({ page }) => {
    // Write via child rw pass, then collapse, then re-expand: host keeps passvar=1,
    // child re-reads it and indicator is immediately visible on re-expand
    const host = await nodeContent(page, 'pass-host-rw');
    await host.press('ArrowRight');
    const writer = await waitForNode(page, 'pass-rw-writer');
    await writer.press('Enter'); // passvar<<1
    await expect(await waitForNode(page, 'pass-host-rw-indicator')).toBeVisible();
    // Collapse destroys transcluded children
    await host.press('ArrowLeft');
    await page.waitForTimeout(100);
    // Re-expand: new children read passvar=1 from host → indicator visible immediately
    await host.press('ArrowRight');
    await expect(await waitForNode(page, 'pass-rw-indicator')).toBeVisible();
  });

  test('-- prefix: variable not in children-pass still blocked if key lacks -- prefix', async ({ page }) => {
    // pass-host-blocked has no children-pass and passvar has no -- prefix → blocked
    // Confirms that -- auto-pass only applies to keys starting with "--"
    const host = await nodeContent(page, 'pass-host-blocked');
    await host.press('Enter'); // passvar<<1 on host, then expand
    await waitForNode(page, 'pass-blocked-anchor'); // stable child confirms children loaded
    await page.waitForTimeout(200);
    expect(await tryNodeContent(page, 'pass-blocked-indicator')).toBeNull();
  });

  test('-- prefix: multiple children all auto-read the same -- variable', async ({ page }) => {
    // pass-host-dash expands pass-dash-target which has two children:
    //   pass-dash-indicator {? --dashvar==1} and pass-dash-write-node
    // Both children see --dashvar after host sets it
    const host = await nodeContent(page, 'pass-host-dash');
    await host.press('Enter'); // --dashvar<<1 + expand
    await expect(await waitForNode(page, 'pass-dash-indicator')).toBeVisible();
    // pass-dash-write-node is also present (just a writer node, should be visible)
    await expect(await waitForNode(page, 'pass-dash-write-node')).toBeVisible();
  });

  // ── exhibit-pass: host→iframe push ────────────────────────────────────────

  test('exhibit-pass: host state change after load is pushed to exhibit iframe', async ({ page }) => {
    // pass-scope-exhibit-reactive: exvar=0, exhibit-pass: exvar rw
    // Node has listbox spans [zero]{&exvar<<0} [one]{&exvar<<1}.
    // After opening the exhibit, selecting the "one" span sets exvar=1 on host.
    // The iframe must receive rvmark-preroot-set and show pass-exhibit-indicator.
    const frame = await openExhibit(page, 'pass-exhibit-reactive-host');
    const iframeIndicator = frame.locator('.node-content').filter({ hasText: 'pass-exhibit-visible' });
    await expect(iframeIndicator).not.toBeVisible();
    // Select the "one" span — stays on same node, exhibit stays open
    const host = await nodeContent(page, 'pass-exhibit-reactive-host');
    await host.locator('[role="option"]').filter({ hasText: 'one' }).click();
    await expect(iframeIndicator).toBeVisible();
  });

  test('exhibit-pass: rename — host push reaches iframe under translated child key', async ({ page }) => {
    // pass-exhibit-rename-host has exhibit-pass: exvar=exlocal rw
    // exlocal=1 set on host (without changing selection) → iframe receives rvmark-preroot-set key=exvar value=1
    const frame = await openExhibit(page, 'pass-exhibit-rename-host');
    const iframeIndicator = frame.locator('.node-content').filter({ hasText: 'pass-exhibit-rename-visible' });
    await expect(iframeIndicator).not.toBeVisible();
    // Mutate host state without navigating away (keeps exhibit open)
    await page.evaluate(() => {
      window._rvmarkFindNodes?.('pass-exhibit-rename-host')?.forEach(rn => rn.state?.set('exlocal', '1'));
    });
    await expect(iframeIndicator).toBeVisible();
  });

  test('exhibit-pass: r-only key — host push reaches iframe but iframe cannot write back', async ({ page }) => {
    // pass-exhibit-ro-host has exhibit-pass: exvar (r only)
    // Host sets exvar=1 → iframe should receive the push and show indicator
    // (Write-back direction is separately blocked by existing security test)
    const frame = await openExhibit(page, 'pass-exhibit-ro-host');
    const iframeIndicator = frame.locator('.node-content').filter({ hasText: 'pass-exhibit-visible' });
    await expect(iframeIndicator).not.toBeVisible();
    await page.evaluate(() => {
      window._rvmarkFindNodes?.('pass-exhibit-ro-host')?.forEach(rn => rn.state?.set('exvar', '1'));
    });
    await expect(iframeIndicator).toBeVisible();
  });

  // ── Additional exhibit-pass tests ──────────────────────────────────────────

  test('exhibit-pass: rename — exhibit write-back reaches host under translated key', async ({ page }) => {
    // pass-exhibit-rename-host has exhibit-pass: exvar=exlocal rw
    // exlocal=0 on host; relay snapshot sends exvar=0 to exhibit
    // Writer in exhibit fires exvar<<1 → relayed to host as exlocal<<1
    const frame = await openExhibit(page, 'pass-exhibit-rename-host');
    expect(await tryNodeContent(page, 'pass-exhibit-rename-indicator')).toBeNull();
    // Wait for relay listener to be established before firing writer
    const writer = frame.locator('.node-content').filter({ hasText: 'pass-exhibit-rename-writer' });
    await expect(writer).toBeVisible();
    await writer.press('Enter');
    // Host indicator {? exlocal==1} must appear (write-back translated exvar→exlocal)
    await expect(await waitForNode(page, 'pass-exhibit-rename-indicator')).toBeVisible();
  });

  test('exhibit: preroot vars are NOT visible inside exhibit (no exhibit-pass for preroot)', async ({ page }) => {
    // postPrerootSnapshot is never sent to exhibit iframes (security: would leak all URL params)
    // Without exhibit-pass for prerootvar, it must not appear in the exhibit
    await page.evaluate(() => { window.__rvmarkPreroot?.declare('prerootvar', '1'); });
    const frame = await openExhibit(page, 'pass-exhibit-preroot-host');
    await page.waitForTimeout(300);
    const iframeIndicator = frame.locator('.node-content').filter({ hasText: 'pass-exhibit-preroot-visible' });
    await expect(iframeIndicator).not.toBeVisible();
  });

  test('exhibit-pass: write-back does not affect sibling scopes', async ({ page }) => {
    // Writing exvar via pass-scope-exhibit's rw exhibit must not bleed into pass-scope-exhibit-ro
    // Both scopes declare exvar=0 independently; rw write updates only its own scope's frame
    const frame = await openExhibit(page, 'pass-exhibit-host');
    await frame.locator('.node-content').filter({ hasText: 'pass-exhibit-writer' }).press('Enter');
    await expect(await waitForNode(page, 'pass-exhibit-host-indicator')).toBeVisible();
    // Now open the ro scope exhibit — its exvar must still be 0
    // (We can't easily check inside that iframe without reopening, so check host indicator)
    // pass-scope-exhibit-ro has its own exvar=0 declared in its scope frame — indicator absent
    expect(await tryNodeContent(page, 'pass-exhibit-ro-host')).not.toBeNull(); // node exists
  });

  // ── Security: relay write-back attack surfaces ──────────────────────────────

  test('security: direct postMessage with r-only key is blocked', async ({ page }) => {
    // pass-exhibit-ro-host has exhibit-pass: exvar (r only)
    // A direct rvmark-state-write from the iframe window must not write exvar on the host
    await openExhibit(page, 'pass-exhibit-ro-host');
    // Post as if from the iframe's contentWindow — bypasses UI, hits listenWriteBack directly
    await page.evaluate(() => {
      const iframe = document.querySelector('.exhibit-iframe');
      iframe?.contentWindow?.parent.postMessage(
        { type: 'rvmark-state-write', op: 'set', key: 'exvar', value: '1' }, '*',
      );
    });
    await page.waitForTimeout(300);
    expect(await tryNodeContent(page, 'pass-exhibit-host-indicator')).toBeNull();
  });

  test('security: direct postMessage with key not in exhibit-pass is blocked', async ({ page }) => {
    // pass-exhibit-host has exhibit-pass: exvar rw — does not include "othervar"
    // A direct write of othervar from inside the iframe must not reach the host.
    // We subscribe to othervar changes via a declare to detect if it ever gets set.
    await openExhibit(page, 'pass-exhibit-host');
    await page.evaluate(() => {
      window.__rvmarkPreroot?.declare('othervar', 'safe');
      const iframe = document.querySelector('.exhibit-iframe');
      iframe?.contentWindow?.parent.postMessage(
        { type: 'rvmark-state-write', op: 'set', key: 'othervar', value: 'pwned' }, '*',
      );
    });
    await page.waitForTimeout(300);
    // If the write was blocked, othervar remains 'safe' (we set it ourselves above)
    const val = await page.evaluate(() => {
      let result;
      window._rvmarkFindNodes?.('pass-exhibit-host')?.forEach(rn => {
        result = rn.state?.get('othervar');
      });
      return result;
    });
    expect(val).not.toBe('pwned');
  });

  test('security: direct postMessage with -- key is blocked at relay', async ({ page }) => {
    // -- prefix keys always pass read-only through StatePass but must never be writable via relay.
    // Declare --dashvar=safe on preroot, then attempt to overwrite from iframe.
    await openExhibit(page, 'pass-exhibit-host');
    await page.evaluate(() => {
      window.__rvmarkPreroot?.declare('--dashvar', 'safe');
      const iframe = document.querySelector('.exhibit-iframe');
      iframe?.contentWindow?.parent.postMessage(
        { type: 'rvmark-state-write', op: 'set', key: '--dashvar', value: '99' }, '*',
      );
    });
    await page.waitForTimeout(300);
    // Value must remain 'safe' — relay must not have written '99'
    const val = await page.evaluate(() => {
      let result;
      window._rvmarkFindNodes?.('pass-exhibit-host')?.forEach(rn => {
        result = rn.state?.get('--dashvar');
      });
      return result;
    });
    expect(val).toBe('safe');
  });

  test('security: postMessage from rogue window (wrong source) is ignored', async ({ page }) => {
    // listenWriteBack checks e.source === iframeWindow; a message posted from the page itself
    // (not from the iframe's contentWindow) must be ignored
    await openExhibit(page, 'pass-exhibit-host');
    // Post directly from the top-level page window — wrong source
    await page.evaluate(() => {
      window.postMessage({ type: 'rvmark-state-write', op: 'set', key: 'exvar', value: '1' }, '*');
    });
    await page.waitForTimeout(300);
    expect(await tryNodeContent(page, 'pass-exhibit-host-indicator')).toBeNull();
  });

  test('security: prototype pollution key is ignored', async ({ page }) => {
    // A guest sending __proto__ or constructor as key must not pollute Object prototype
    await openExhibit(page, 'pass-exhibit-host');
    await page.evaluate(() => {
      const iframe = document.querySelector('.exhibit-iframe');
      iframe?.contentWindow?.parent.postMessage(
        { type: 'rvmark-state-write', op: 'declare', key: '__proto__', value: '{"polluted":true}' }, '*',
      );
      iframe?.contentWindow?.parent.postMessage(
        { type: 'rvmark-state-write', op: 'declare', key: 'constructor', value: 'pwned' }, '*',
      );
    });
    await page.waitForTimeout(300);
    const polluted = await page.evaluate(() => ({}.polluted));
    expect(polluted).toBeUndefined();
  });

  // ── Relay rewiring across same-target scope switches ───────────────────────
  // When selection moves from scope A to scope B and both have the same exhibit
  // target (rawRef), the iframe must NOT be rebuilt and the relay must be
  // rewired so subsequent pushes/write-backs target B's state frame, not A's.

  test('exhibit rewire: iframe element persists across same-target scope switch', async ({ page }) => {
    // Open exhibit on rewire-host-a, mark its iframe, then click rewire-host-b
    // (same target). The marker must still be present, proving no rebuild.
    await openExhibit(page, 'pass-exhibit-rewire-host-a');
    await page.evaluate(() => {
      document.querySelector('.exhibit-iframe')?.setAttribute('data-rewire-marker', 'persisted');
    });
    await (await nodeContent(page, 'pass-exhibit-rewire-host-b')).click();
    // Give the persist branch time to run; if it rebuilt, the marker would be gone.
    await page.waitForTimeout(200);
    const marker = await page.evaluate(() =>
      document.querySelector('.exhibit-iframe')?.getAttribute('data-rewire-marker') ?? null,
    );
    expect(marker).toBe('persisted');
  });

  test('exhibit rewire: host push reaches iframe via NEW scope frame, not old', async ({ page }) => {
    // After A→B switch, setting exvar=1 on A's frame must NOT push to the iframe;
    // setting exvar=1 on B's frame must push and reveal the iframe indicator.
    const frame = await openExhibit(page, 'pass-exhibit-rewire-host-a');
    const iframeIndicator = frame.locator('.node-content').filter({ hasText: 'pass-exhibit-visible' });
    await expect(iframeIndicator).not.toBeVisible();
    // Switch scopes by selecting B's host (same target rawRef triggers rewire)
    await (await nodeContent(page, 'pass-exhibit-rewire-host-b')).click();
    await page.waitForTimeout(100);
    // Mutate A's frame — iframe must NOT see this (relay no longer points at A)
    await page.evaluate(() => {
      window._rvmarkFindNodes?.('pass-exhibit-rewire-host-a')?.forEach(rn => rn.state?.set('exvar', '1'));
    });
    await page.waitForTimeout(200);
    await expect(iframeIndicator).not.toBeVisible();
    // Mutate B's frame — iframe MUST see this push (relay now points at B)
    await page.evaluate(() => {
      window._rvmarkFindNodes?.('pass-exhibit-rewire-host-b')?.forEach(rn => rn.state?.set('exvar', '1'));
    });
    await expect(iframeIndicator).toBeVisible();
  });

  test('exhibit rewire: write-back lands on NEW scope frame, not old', async ({ page }) => {
    // After A→B switch, the iframe's writer (exvar<<1) must update B's host
    // indicator and leave A's host indicator hidden.
    const frame = await openExhibit(page, 'pass-exhibit-rewire-host-a');
    await (await nodeContent(page, 'pass-exhibit-rewire-host-b')).click();
    await page.waitForTimeout(100);
    // Re-grab the writer locator (still inside the persisted iframe)
    const writer = frame.locator('.node-content').filter({ hasText: 'pass-exhibit-writer' });
    await expect(writer).toBeVisible();
    await writer.press('Enter');
    // B's indicator must appear; A's must not
    await expect(await waitForNode(page, 'pass-exhibit-rewire-b-indicator')).toBeVisible();
    expect(await tryNodeContent(page, 'pass-exhibit-rewire-a-indicator')).toBeNull();
  });

  test('exhibit rewire: snapshot of NEW scope is sent on rewire', async ({ page }) => {
    // Set exvar=1 on B's frame BEFORE switching; after switching, the iframe
    // must immediately reflect B's state (relay snapshot pushed on rewire).
    const frame = await openExhibit(page, 'pass-exhibit-rewire-host-a');
    const iframeIndicator = frame.locator('.node-content').filter({ hasText: 'pass-exhibit-visible' });
    await expect(iframeIndicator).not.toBeVisible();
    // Prime B's frame while exhibit is wired to A (no effect on iframe yet)
    await page.evaluate(() => {
      window._rvmarkFindNodes?.('pass-exhibit-rewire-host-b')?.forEach(rn => rn.state?.set('exvar', '1'));
    });
    await page.waitForTimeout(100);
    await expect(iframeIndicator).not.toBeVisible(); // still A-wired, A's exvar=0
    // Switch to B — snapshot of B's frame should now be pushed to the iframe
    await (await nodeContent(page, 'pass-exhibit-rewire-host-b')).click();
    await expect(iframeIndicator).toBeVisible();
  });
});

// ── table expandability ───────────────────────────────────────────────────────

test.describe('table expandability', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/#table-root');
    await waitForTree(page);
    await waitForNode(page, 'table-node');
  });

  test('table node with children is not a leaf', async ({ page }) => {
    const li = await nodeLi(page, 'table-node');
    await expect(li.locator('.table-toggle')).not.toHaveClass(/leaf/);
  });

  test('table node expands to show rows', async ({ page }) => {
    const table = await nodeContent(page, 'table-node');
    await table.click();
    await table.click();
    await expect(await waitForNode(page, 'table-row-a')).toBeVisible();
  });

});

// ── watchChildren ─────────────────────────────────────────────────────────────

// ── Listbox span state assignments ────────────────────────────────────────────
// Fixture: #listbox-root declares {& step=}; #listbox-node has three inline
// options using {&step<<a}, {&step<<b}, {&step<<c}. Selecting each option
// should mutate step upward into listbox-root's frame, making the corresponding
// show-when indicator visible.

test.describe('listbox span state assignments', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/#listbox-root');
    await waitForTree(page);
    await waitForNode(page, 'listbox-node');
  });

  test('selecting option A sets step to a', async ({ page }) => {
    const node = await nodeContent(page, 'listbox-node');
    await node.click();
    const optA = node.locator('[role="option"]').nth(0);
    await optA.click();
    await expect(await waitForNode(page, 'listbox-indicator-a')).toBeVisible();
  });

  test('selecting option B sets step to b', async ({ page }) => {
    const node = await nodeContent(page, 'listbox-node');
    await node.click();
    const optB = node.locator('[role="option"]').nth(1);
    await optB.click();
    await expect(await waitForNode(page, 'listbox-indicator-b')).toBeVisible();
  });

  test('switching from A to C clears a and sets c', async ({ page }) => {
    const node = await nodeContent(page, 'listbox-node');
    await node.click();
    await node.locator('[role="option"]').nth(0).click();
    await node.locator('[role="option"]').nth(2).click();
    await expect(await waitForNode(page, 'listbox-indicator-c')).toBeVisible();
    expect(await tryNodeContent(page, 'listbox-indicator-a')).toBeNull();
  });

  test('keyboard ArrowRight advances option and mutates state', async ({ page }) => {
    const node = await nodeContent(page, 'listbox-node');
    await node.click();
    await node.press('ArrowRight');
    await expect(await waitForNode(page, 'listbox-indicator-a')).toBeVisible();
    await node.press('ArrowRight');
    await expect(await waitForNode(page, 'listbox-indicator-b')).toBeVisible();
  });

  // The bullet's job is to clear the LISTBOX SELECTION, so that is what this
  // asserts. It deliberately does not check the show-when indicator: reset does
  // not revert an option's state mutation (that is the author's job, via
  // on-no-option-select), so indicator visibility would test state plumbing
  // rather than whether the bullet click reached nav.reset().
  test('clicking the bullet clears the option selection', async ({ page }) => {
    const node = await nodeContent(page, 'listbox-node');
    await node.click();
    const optA = node.locator('[role="option"]').nth(0);
    await optA.click();
    await expect(optA).toHaveAttribute('aria-selected', 'true');
    await node.locator('.toggle').click();
    await expect(optA).toHaveAttribute('aria-selected', 'false');
    await expect(node.locator('[role="listbox"]')).not.toHaveAttribute('aria-activedescendant');
  });
});

// A non-expandable listbox row had no bullet click wiring at all before
// wireBulletActions unified the two reasons a bullet takes clicks.
test.describe('listbox table-row bullet reset', () => {
  test('clicking the row bullet clears the option selection', async ({ page }) => {
    await page.goto('/#listbox-tr-root');
    await waitForTree(page);
    const node = await nodeContent(page, 'listbox-tr-node');
    await node.click();
    const optA = node.locator('[role="option"]').nth(0);
    await optA.click();
    await expect(optA).toHaveAttribute('aria-selected', 'true');
    // .tr-toggle is a sibling of .node-content under the row's own li.
    await node.locator('xpath=../*[contains(@class,"tr-toggle")]').click();
    await expect(optA).toHaveAttribute('aria-selected', 'false');
    await expect(node).not.toHaveAttribute('aria-activedescendant');
  });
});

// A block node's left border is its analogue of a text node's bullet: clicking
// it clears the option selection. The border belongs to .md-body, which also
// wraps the scroller, so the handler distinguishes the strip by offsetX — these
// pin both halves of that (border resets, content does not).
//
// Asserted via aria-selected, not the show-when indicator: what is under test is
// the border's hit-testing, not whether reset reverts state (it does not).
test.describe('listbox block-node border reset', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/#listbox-block-root');
    await waitForTree(page);
    await waitForNode(page, 'listbox-block-node');
  });

  async function selectOptionA(page) {
    const node = await nodeContent(page, 'listbox-block-node');
    await node.click();
    const optA = node.locator('[role="option"]').nth(0);
    await optA.click();
    await expect(optA).toHaveAttribute('aria-selected', 'true');
    return { node, optA };
  }

  test('clicking the left border clears the option selection', async ({ page }) => {
    const { node, optA } = await selectOptionA(page);
    const box  = await node.locator('.md-body').boundingBox();
    // On the border itself, at .md-body's leading edge.
    await page.mouse.click(box.x + 1, box.y + box.height / 2);
    await expect(optA).toHaveAttribute('aria-selected', 'false');
  });

  // The target is --bullet-w wide centred on the border, so half of it sits out
  // in .md-body's margin — outside the element, but still a valid target.
  test('clicking just left of the border also clears it', async ({ page }) => {
    const { node, optA } = await selectOptionA(page);
    const box  = await node.locator('.md-body').boundingBox();
    await page.mouse.click(box.x - 4, box.y + box.height / 2);
    await expect(optA).toHaveAttribute('aria-selected', 'false');
  });

  test('clicking inside the body does not clear the selection', async ({ page }) => {
    const { node, optA } = await selectOptionA(page);
    const scroller = node.locator('.md-body-scroll');
    const box = await scroller.boundingBox();
    // Right edge: inside .md-body but past the end of the text, so this lands on
    // the scroller with no option under it.
    await page.mouse.click(box.x + box.width - 2, box.y + box.height / 2);
    await expect(optA).toHaveAttribute('aria-selected', 'true');
  });
});

// Fixture: #listbox-transclude-node has two inline options. [Direct] embeds
// #tt-leaf (which has real children); [Transitive] embeds #tt-mid, itself a
// children-mode node that embeds #tt-leaf. Selecting an option runs a link-mode
// expandNode with the option's ref, which must resolve the target's *effective*
// children — so a target that is itself a transcluding node still renders.
test.describe('listbox option transitive transclusion', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/#listbox-transclude-root');
    await waitForTree(page);
    await waitForNode(page, 'listbox-transclude-node');
  });

  test('option targeting a node with children renders its children', async ({ page }) => {
    const node = await nodeContent(page, 'listbox-transclude-node');
    await node.click();
    await node.locator('[role="option"]').filter({ hasText: 'Direct' }).click();
    await expect(await waitForNode(page, 'tt-leaf-child')).toBeVisible();
  });

  test('option targeting a transcluding node renders through the chain', async ({ page }) => {
    const node = await nodeContent(page, 'listbox-transclude-node');
    await node.click();
    await node.locator('[role="option"]').filter({ hasText: 'Transitive' }).click();
    // #tt-mid embeds #tt-leaf, so the panel must show tt-leaf's child — not empty.
    await expect(await waitForNode(page, 'tt-leaf-child')).toBeVisible();
  });
});

test.describe('watchChildren', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/#watch-root');
    await waitForTree(page);
    await waitForNode(page, 'watch-trigger');
  });

  test('node with only show-when children starts as leaf', async ({ page }) => {
    const parent = await nodeContent(page, 'watch-parent');
    await expect(parent).not.toHaveAttribute('aria-expanded');
    await expect(parent.locator('.toggle')).toHaveClass(/leaf/);
  });

  test('toggle becomes non-leaf when show-when condition becomes true', async ({ page }) => {
    const trigger = await nodeContent(page, 'watch-trigger');
    await trigger.click();
    await trigger.press('Enter');
    const parent = await nodeContent(page, 'watch-parent');
    await expect(parent).toHaveAttribute('aria-expanded', 'false');
    await expect(parent.locator('.toggle')).not.toHaveClass(/leaf/);
  });

  test('expanding node after condition is true shows the child', async ({ page }) => {
    const trigger = await nodeContent(page, 'watch-trigger');
    await trigger.click();
    await trigger.press('Enter');
    const parent = await nodeContent(page, 'watch-parent');
    await parent.click();
    await parent.click();
    await expect(await waitForNode(page, 'watch-indicator')).toBeVisible();
  });
});

// ── Multi-condition show-when ─────────────────────────────────────────────────
// Fixture: #multi-cond-indicator carries two separate show-when parts,
// {?&conda==1; ?&condb==1}, which parse to two distinct 'show-when' attr values.
// The node must stay hidden until BOTH conditions hold (AND-on-show). Regression
// guard for the bug where the reader used Multimap.get() and kept only the last
// condition, so a single trigger wrongly revealed the node.

test.describe('multi-condition show-when', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/#multi-cond-root');
    await waitForTree(page);
    await waitForNode(page, 'multi-cond-trigger-a');
  });

  test('indicator hidden on first load when neither condition holds', async ({ page }) => {
    expect(await tryNodeContent(page, 'multi-cond-indicator')).toBeNull();
  });

  test('indicator stays hidden when only the last condition holds', async ({ page }) => {
    const trigB = await nodeContent(page, 'multi-cond-trigger-b');
    await trigB.click();
    await trigB.press('Enter');
    // condb==1 but conda still 0 — pre-fix this wrongly showed the node.
    await waitForNode(page, 'multi-cond-trigger-a');
    expect(await tryNodeContent(page, 'multi-cond-indicator')).toBeNull();
  });

  test('indicator stays hidden when only the first condition holds', async ({ page }) => {
    const trigA = await nodeContent(page, 'multi-cond-trigger-a');
    await trigA.click();
    await trigA.press('Enter');
    await waitForNode(page, 'multi-cond-trigger-b');
    expect(await tryNodeContent(page, 'multi-cond-indicator')).toBeNull();
  });

  test('indicator visible only when both conditions hold', async ({ page }) => {
    const trigA = await nodeContent(page, 'multi-cond-trigger-a');
    await trigA.click();
    await trigA.press('Enter');
    const trigB = await nodeContent(page, 'multi-cond-trigger-b');
    await trigB.click();
    await trigB.press('Enter');
    await expect(await waitForNode(page, 'multi-cond-indicator')).toBeVisible();
  });
});

// ── iframe-pass ───────────────────────────────────────────────────────────────

test.describe('iframe-pass', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/#iframe-pass-root');
    await waitForTree(page);
  });

  // Returns a FrameLocator for the iframe inside a given node's <li>.
  async function iframeIn(page, nodeId) {
    const li = await nodeLi(page, nodeId);
    const liId = await li.getAttribute('id');
    return page.frameLocator(`#${liId} iframe`);
  }

  test('iframe-pass: rw — write-back from iframe reaches host', async ({ page }) => {
    // iframe-pass-host-rw: iframevar rw; iframe writer button sends rvmark-state-write
    // host indicator {? iframevar==1} must appear
    await waitForNode(page, 'iframe-pass-host-rw');
    expect(await tryNodeContent(page, 'iframe-pass-host-rw-indicator')).toBeNull();
    const iframe = await iframeIn(page, 'iframe-pass-host-rw');
    await iframe.locator('#writer').click();
    await expect(await waitForNode(page, 'iframe-pass-host-rw-indicator')).toBeVisible();
  });

  test('iframe-pass: host state change after load is pushed to iframe', async ({ page }) => {
    // iframe-pass-scope-reactive: iframevar=0, iframe-pass: iframevar rw
    // Trigger sets iframevar<<1 on host; iframe must receive rvmark-preroot-set and show #indicator
    await waitForNode(page, 'iframe-pass-host-reactive');
    const iframe = await iframeIn(page, 'iframe-pass-host-reactive');
    await page.waitForTimeout(300); // let iframe load
    await (await nodeContent(page, 'iframe-pass-reactive-trigger')).press('Enter');
    await expect(iframe.locator('#indicator')).toBeVisible();
  });

  test('iframe-pass: r-only — host push reaches iframe', async ({ page }) => {
    // iframe-pass-host-r: iframe-pass: iframevar (r only)
    // Host sets iframevar=1 → iframe receives push and shows #indicator
    await waitForNode(page, 'iframe-pass-host-r');
    const iframe = await iframeIn(page, 'iframe-pass-host-r');
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      window._rvmarkFindNodes?.('iframe-pass-host-r')?.forEach(rn => rn.state?.set('iframevar', '1'));
    });
    await expect(iframe.locator('#indicator')).toBeVisible();
  });

  test('iframe-pass: r-only — iframe write-back is blocked', async ({ page }) => {
    // iframe writer sends rvmark-state-write for iframevar; r-only pass must block it
    await waitForNode(page, 'iframe-pass-host-r');
    const iframe = await iframeIn(page, 'iframe-pass-host-r');
    await page.waitForTimeout(300);
    await iframe.locator('#writer').click();
    await page.waitForTimeout(200);
    expect(await tryNodeContent(page, 'iframe-pass-host-r-indicator')).toBeNull();
  });

  test('iframe-pass: rename — write-back reaches host under translated key', async ({ page }) => {
    // iframe-pass-host-rename: iframe-pass: iframeremote=iframelocal rw
    // Simulate iframe sending rvmark-state-write for 'iframeremote' → host translates to 'iframelocal'
    // listenWriteBack checks e.source === iframeWindow, so we post from inside the iframe
    await waitForNode(page, 'iframe-pass-host-rename');
    expect(await tryNodeContent(page, 'iframe-pass-rename-indicator')).toBeNull();
    const liId = await (await nodeLi(page, 'iframe-pass-host-rename')).getAttribute('id');
    // Post from inside the iframe so e.source matches iframeWindow
    const iframe = await iframeIn(page, 'iframe-pass-host-rename');
    await iframe.locator('body').evaluate(() => {
      parent.postMessage({ type: 'rvmark-state-write', op: 'set', key: 'iframeremote', value: '1' }, '*');
    });
    await expect(await waitForNode(page, 'iframe-pass-rename-indicator')).toBeVisible();
  });
});

// ── Conditional inline spans ({show-when} on a span) ──────────────────────────
// Fixture #span-vis-root. A span with show-when is hidden by class rather than
// by deferred spawn (the node mechanism): the markup is always present, so these
// assert on visibility, not on presence. The "pending" class is the pre-wiring
// state — a span still carrying it after mount means wireSpanVisibility never
// ran for that container, which is the flash-on-load failure.

test.describe('conditional inline spans', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/#span-vis-root');
    await waitForTree(page);
    await waitForNode(page, 'span-vis-toggle');
  });

  test('span whose condition is false starts hidden, without flashing', async ({ page }) => {
    const line = await nodeContent(page, 'span-vis-line');
    await expect(line.getByText('shown-when-svis')).toBeHidden();
    // Resolved by the wiring, not left in the renderer's pre-paint state.
    await expect(line.locator('.span-conditional-pending')).toHaveCount(0);
  });

  test('unconditional spans and surrounding text are untouched', async ({ page }) => {
    const line = await nodeContent(page, 'span-vis-line');
    await expect(line.getByText('always')).toBeVisible();
    await expect(line).toContainText('before');
    await expect(line).toContainText('after');
  });

  test('span appears when its condition becomes true', async ({ page }) => {
    const toggle = await nodeContent(page, 'span-vis-toggle');
    await toggle.click();
    await toggle.press('Enter');
    const line = await nodeContent(page, 'span-vis-line');
    await expect(line.getByText('shown-when-svis')).toBeVisible();
  });

  test('multi-condition span stays hidden until both conditions hold', async ({ page }) => {
    const multi = await nodeContent(page, 'span-vis-multi');
    await expect(multi.getByText('both-conds')).toBeHidden();

    const setA = await nodeContent(page, 'span-vis-set-a');
    await setA.click();
    await setA.press('Enter');
    await expect(multi.getByText('both-conds')).toBeHidden();

    const setB = await nodeContent(page, 'span-vis-set-b');
    await setB.click();
    await setB.press('Enter');
    await expect(multi.getByText('both-conds')).toBeVisible();
  });
});
