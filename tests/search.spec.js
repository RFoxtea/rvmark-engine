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
 *     29.4. {#search-child-tagged} [SearchTagVisible] [.searchtaghidden] — a
 *           rendered chip and an implicitly-internal (chipless) tag
 *   30. {#search-unsearchable-node} SEARCHABLE_NEEDLE_TEXT (outside any {searchable} scope)
 *     30.1. {#search-unsearchable-child} UNSEARCHABLE_HIDDEN_TEXT (unmounted,
 *           and outside {searchable}, so never reached)
 *
 * tests/rvmark/searchable-dir/index.rvmark carries file-level {searchable}
 * in its meta block, inherited to every file under that directory. It is also
 * transcluded into tests/rvmark/other.rvmark (#other-mixed-host), which has no
 * {searchable} of its own — the "mixed page" case, i.e. the site-index shape.
 *
 * {searchable} is not what makes search appear: the widget is on every page
 * and always matches rendered content. {searchable} only extends matching past
 * what is rendered, which is what produces the breadcrumb dots.
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
  // {searchable} is not a switch that turns search on — it only extends reach
  // past what is rendered. The widget is available on every interactive page.
  test('is present on a page with no {searchable} scope at all', async ({ page }) => {
    await page.goto('/other/');
    await waitForTree(page);
    await expect(page.locator('.search-widget')).toHaveCount(1);
  });

  test('Ctrl+F is intercepted even with no {searchable} scope', async ({ page }) => {
    await page.goto('/other/');
    await waitForTree(page);
    const prevented = await page.evaluate(() => new Promise((resolve) => {
      window.addEventListener('keydown', (e) => resolve(e.defaultPrevented), { once: true });
      const evt = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, cancelable: true, bubbles: true });
      window.dispatchEvent(evt);
    }));
    expect(prevented).toBe(true);
  });

  test('rendered content is matchable on a page with no {searchable} scope', async ({ page }) => {
    await page.goto('/other/');
    await waitForTree(page);
    await page.keyboard.press('Control+f');
    const text = await page.locator('li.node .node-label').first().textContent();
    await page.locator('.search-input').fill(text.trim().slice(0, 12));
    await expect(page.locator('.search-mark').first()).toBeVisible();
  });

  test('is present (but inactive) on the index page', async ({ page }) => {
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

  test('Enter selects the first mounted match, but leaves focus in the search input', async ({ page }) => {
    await page.goto('/');
    await waitForTree(page);
    await page.keyboard.press('Control+f');
    await page.locator('.search-input').fill('SEARCHABLE_VISIBLE_TEXT');
    await page.keyboard.press('Enter');

    const row = await nodeContent(page, 'search-child-visible');
    await expect(row).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.search-input')).toBeFocused();
  });

  // Outside {searchable}, search still sees everything rendered — a mounted
  // node matches normally. What it must not do is reach past the render.
  test('a mounted node outside {searchable} still matches and marks', async ({ page }) => {
    await page.goto('/');
    await waitForTree(page);
    await page.keyboard.press('Control+f');
    await page.locator('.search-input').fill('SEARCHABLE_NEEDLE_TEXT');

    const row = await nodeContent(page, 'search-unsearchable-node');
    await expect(row.locator('.search-mark')).toHaveCount(1);
  });

  // The other half: unmounted content outside {searchable} is not reachable,
  // so it yields neither a match nor a breadcrumb dot on its collapsed parent.
  test('unmounted content outside {searchable} is not reached', async ({ page }) => {
    await page.goto('/');
    await waitForTree(page);
    await page.keyboard.press('Control+f');
    await page.locator('.search-input').fill('UNSEARCHABLE_HIDDEN_TEXT');

    await expect(page.locator('.search-input')).toHaveClass(/search-input--no-matches/);
    const parent = await nodeContent(page, 'search-unsearchable-node');
    await expect(parent.locator('.search-indicator')).toHaveCount(0);
  });

  test('a match under a collapsed node marks the ancestor toggle, without expanding it', async ({ page }) => {
    await page.goto('/');
    await waitForTree(page);

    const collapsedRow = await nodeContent(page, 'search-child-collapsed');
    await expect(collapsedRow).toHaveAttribute('aria-expanded', 'false');

    await page.keyboard.press('Control+f');
    await page.locator('.search-input').fill('SEARCHABLE_NEEDLE_TEXT');

    // The indicator is a .search-indicator sibling of .toggle, not a class on
    // .toggle itself — .toggle rotates when expanded and already owns an
    // ::after badge, so the marker deliberately lives outside it.
    await expect(collapsedRow.locator('.search-indicator')).toHaveCount(1);
    // Still collapsed — search must never force a reveal.
    await expect(collapsedRow).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#tree-root #search-grandchild-collapsed')).toHaveCount(0);
  });

  // A breadcrumb dot means a match exists below that the reader cannot yet
  // see — Enter should be able to land there directly, not only on rows with
  // a real .search-mark, otherwise reaching a hidden match requires first
  // finding and expanding the exact right collapsed ancestor by hand.
  test('Enter can step onto a collapsed node carrying only a breadcrumb dot', async ({ page }) => {
    await page.goto('/');
    await waitForTree(page);
    await page.keyboard.press('Control+f');
    await page.locator('.search-input').fill('SEARCHABLE_NEEDLE_TEXT');
    await page.keyboard.press('Enter');

    const collapsedRow = await nodeContent(page, 'search-child-collapsed');
    await expect(collapsedRow).toHaveAttribute('aria-selected', 'true');
    // Selecting it must not force it open.
    await expect(collapsedRow).toHaveAttribute('aria-expanded', 'false');
  });

  // Regression: expanding a breadcrumb-only stop drops it out of the target
  // list entirely (it has no match of its own, and it is no longer
  // collapsed), while it stays selected. Stepping again must resume from that
  // now-stale selection's position — landing on the just-revealed match right
  // after it — not treat the non-target selection as "nothing selected" and
  // restart from the very first result.
  test('stepping again after expanding a breadcrumb stop continues to the revealed match', async ({ page }) => {
    await page.goto('/');
    await waitForTree(page);
    await page.keyboard.press('Control+f');
    await page.locator('.search-input').fill('SEARCHABLE_NEEDLE_TEXT');
    await page.keyboard.press('Enter');

    const collapsedRow = await nodeContent(page, 'search-child-collapsed');
    await expect(collapsedRow).toHaveAttribute('aria-selected', 'true');

    await collapsedRow.locator('.toggle').click();
    await expect(collapsedRow).toHaveAttribute('aria-expanded', 'true');

    await page.locator('.search-input').focus();
    await page.keyboard.press('Enter');

    const grandchild = await nodeContent(page, 'search-grandchild-collapsed');
    await expect(grandchild).toHaveAttribute('aria-selected', 'true');
    await expect(collapsedRow).not.toHaveAttribute('aria-selected', 'true');
  });

  // Tags are stripped out of node.label by the parser, so matching them takes
  // an explicit pass over node.tags — without it a chip sitting plainly on
  // screen is unsearchable, while the same word in prose still matches.
  test('a tag chip\'s visible text is matchable and gets marked', async ({ page }) => {
    await page.goto('/');
    await waitForTree(page);
    await page.keyboard.press('Control+f');
    await page.locator('.search-input').fill('SearchTagVisible');

    const row = await nodeContent(page, 'search-child-tagged');
    await expect(row.locator('.node-tag .search-mark')).toHaveCount(1);
  });

  // Dot-prefixed tags are implicitly `internal` and render no chip at all.
  // Matching them would produce a hit with nothing highlighted on screen.
  test('a tag that renders no chip is not matchable', async ({ page }) => {
    await page.goto('/');
    await waitForTree(page);
    await page.keyboard.press('Control+f');
    await page.locator('.search-input').fill('searchtaghidden');

    await expect(page.locator('.search-input')).toHaveClass(/search-input--no-matches/);
  });

  // A block's text lives in a .block-body sibling of .node-label, so marking has
  // to walk .node-content rather than .node-label alone.
  test('text inside a block body is matchable and gets marked', async ({ page }) => {
    await page.goto('/');
    await waitForTree(page);
    await page.keyboard.press('Control+f');
    await page.locator('.search-input').fill('SEARCHABLE_BLOCK_TEXT');

    const row = await nodeContent(page, 'search-child-block');
    await expect(row.locator('.block-body .search-mark')).toHaveCount(1);
  });

  // table/tr rows have no .node-label at all — their cells are .tr-cell
  // children of .node-content, which the old label-scoped marking skipped.
  test('table header and row cells are matchable and get marked', async ({ page }) => {
    await page.goto('/');
    await waitForTree(page);
    await page.keyboard.press('Control+f');

    await page.locator('.search-input').fill('SEARCHABLE_CELL_TEXT');
    const table = await nodeContent(page, 'search-child-table');
    await expect(table.locator('.tr-cell .search-mark')).toHaveCount(1);

    await page.locator('.search-input').fill('SEARCHABLE_ROW_TEXT');
    const row = await nodeContent(page, 'search-child-tr');
    await expect(row.locator('.tr-cell .search-mark')).toHaveCount(1);
  });

  // table/tr rows build their .toggle as a direct child of the <li>, not
  // inside .node-content like every other node type, so an indicator anchored
  // only within .node-content silently never appeared on a table.
  test('a collapsed table gets a breadcrumb dot for a hidden row match', async ({ page }) => {
    await page.goto('/');
    await waitForTree(page);
    await page.keyboard.press('Control+f');
    await page.locator('.search-input').fill('SEARCHABLE_TABLE_DEEP_TEXT');

    const row = await nodeContent(page, 'search-table-collapsed');
    await expect(row).toHaveAttribute('aria-expanded', 'false');
    const li = page.locator('li.node', { has: row }).first();
    await expect(li.locator('.search-indicator')).toHaveCount(1);
  });

  // Scope must come from the source tree, not from rendered ancestors. A page
  // renders exactly one node — the requested slug, or roots[0] (see renderRoot
  // in main.ts) — so the node carrying {searchable} is very often not on the
  // page at all: here the permalink targets a child, leaving the {searchable}
  // root unrendered. Reading scope off DOM ancestors found nothing in scope,
  // the deep walk never ran, and no breadcrumb dot could ever appear.
  test('{searchable} still applies when the node carrying it is not rendered', async ({ page }) => {
    await page.goto('/#search-child-collapsed');
    await waitForTree(page);

    // The {searchable} root is genuinely absent — only its child is rendered.
    await expect(page.locator('li.node', {
      has: page.locator('.node-label', { hasText: 'SEARCHABLE_TOP_TEXT' }),
    })).toHaveCount(0);

    await page.keyboard.press('Control+f');
    await page.locator('.search-input').fill('SEARCHABLE_NEEDLE_TEXT');

    const row = await nodeContent(page, 'search-child-collapsed');
    await expect(row).toHaveAttribute('aria-expanded', 'false');
    await expect(row.locator('.search-indicator')).toHaveCount(1);
  });

  // A `{=> #id}` host has no children until it resolves at expand time, so the
  // deep walk used to stop dead at the host — content that is authored,
  // addressable and (once expanded) visible was unreachable. Under
  // {searchable}, search now follows a same-file ref to find it.
  test('a match behind an unexpanded transclusion is found', async ({ page }) => {
    await page.goto('/');
    await waitForTree(page);
    await page.keyboard.press('Control+f');
    await page.locator('.search-input').fill('SEARCHABLE_TRANSCLUDED_TEXT');

    await expect(page.locator('.search-status')).not.toHaveText('No matches');
  });

  // Finding the match is only half of it: the reader needs somewhere to click.
  // The host carries the dot, since the match itself is not mounted.
  test('a transclusion host gets a breadcrumb dot for a match behind the ref', async ({ page }) => {
    await page.goto('/');
    await waitForTree(page);
    await page.keyboard.press('Control+f');
    await page.locator('.search-input').fill('SEARCHABLE_TRANSCLUDED_TEXT');

    const row = await nodeContent(page, 'search-transclude-host');
    const li = page.locator('li.node', { has: row }).first();
    await expect(li.locator('.search-indicator')).toHaveCount(1);
  });

  // Transclusions may be recursive — the tree is really a graph. An unguarded
  // walk would not fail an assertion here, it would hang the page.
  test('a recursive transclusion does not hang the search walk', async ({ page }) => {
    await page.goto('/');
    await waitForTree(page);
    await page.keyboard.press('Control+f');
    await page.locator('.search-input').fill('SEARCHABLE_VISIBLE_TEXT');

    // The walk crosses the cyclic host on its way through the tree. If the
    // guard failed the main thread would never come back, so any assertion
    // requiring a round-trip to the page is the real check here.
    await expect(page.locator('.search-mark').first()).toBeVisible({ timeout: 5000 });
    expect(await page.evaluate(() => 1 + 1)).toBe(2);
  });

  // Marking mutates the tree the MutationObserver watches, so a mark write
  // that is mistaken for a real tree change recomputes forever. Nothing else
  // here would catch that — it fails no assertion, it just spins.
  test('marking does not retrigger its own tree-change refresh', async ({ page }) => {
    await page.goto('/');
    await waitForTree(page);
    await page.keyboard.press('Control+f');
    await page.locator('.search-input').fill('SEARCHABLE_BLOCK_TEXT');
    await expect(page.locator('.search-mark')).toHaveCount(1);

    // If marking were self-retriggering, marks would be torn down and rebuilt
    // on every frame; a stable element identity across frames proves it settled.
    const stable = await page.evaluate(async () => {
      const first = document.querySelector('.search-mark');
      await new Promise(r => setTimeout(r, 500));
      return first === document.querySelector('.search-mark');
    });
    expect(stable).toBe(true);
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
  // The site-index shape: a page with no {searchable} of its own that
  // transcludes a searchable file. The transcluded nodes belong to a different
  // SourceFile and never appear in this page's roots, so a roots-based search
  // found nothing here — the widget did not even mount.
  test('transcluded searchable content is searchable on an unsearchable page', async ({ page }) => {
    await page.goto('/other/');
    await waitForTree(page);
    await expect(page.locator('.search-widget')).toHaveCount(1);

    await page.keyboard.press('Control+f');
    await page.locator('.search-input').fill('SEARCHABLE_DIR_NEEDLE');

    // Mounted transcluded content matches and marks.
    const row = await nodeContent(page, 'search-dir-child');
    await expect(row.locator('.search-mark')).toHaveCount(1);
  });

  // {searchable} travels with the transcluded file, so its deep reach works
  // across the boundary too — a collapsed node inside it still gets a dot.
  test('transcluded {searchable} still yields breadcrumbs for hidden matches', async ({ page }) => {
    await page.goto('/other/');
    await waitForTree(page);
    await page.keyboard.press('Control+f');
    await page.locator('.search-input').fill('SEARCHABLE_DIR_DEEP_TEXT');

    const collapsed = await nodeContent(page, 'search-dir-collapsed');
    await expect(collapsed).toHaveAttribute('aria-expanded', 'false');
    await expect(collapsed.locator('.search-indicator')).toHaveCount(1);
  });

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
