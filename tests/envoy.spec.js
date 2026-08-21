/**
 * envoy.spec.js — end-to-end tests for site-defined custom node types.
 *
 * A custom type ({= echo}) routes its SourceNode through an OriginEnvoy: an
 * invisible, sandboxed, per-origin iframe (envoy.html) that runs untrusted
 * author code and returns a SourceNode the engine renders normally.
 *
 * Fixture (tests/rvmark/index.rvmark, node #envoy-root):
 *   24. {#envoy-root; open}
 *     1. {#envoy-echo-a; = echo} Echo node A …      → passed through, rewritten to text
 *       1. {#envoy-echo-a-child} …                  → child survives round-trip
 *     2. {#envoy-echo-b; = echo} Echo node B …      → reuses the same origin envoy
 *     3. {#envoy-missing; = nonexistent} …          → no transform → error node
 *
 * Author transform (tests/custom-types/echo.ts): identity, only rewriting
 * {type: echo} → {type: text} so the output is a built-in.
 */

import { test, expect } from '@playwright/test';

// Scoped to #tree-scroll: the build-time static fallback emits li.node[id]
// markup too, and it never gets a _renderNode.
async function waitForTree(page) {
  await expect(page.locator('#tree-scroll')).not.toHaveCSS('display', 'none');
  await page.waitForFunction(() => {
    return !!document.querySelector('#tree-scroll li.node[id]')?._renderNode;
  });
}

/** Wait until a node id resolves to a live RenderNode whose handler is no longer
 *  the loading placeholder (i.e. the envoy round-trip completed). */
async function waitForResolved(page, id, timeout = 5000) {
  await page.waitForFunction((id) => {
    const rn = window._rvmarkFindNodes?.(id)?.[0];
    if (!rn) return false;
    const content = rn.li.querySelector(':scope > .node-content');
    return !!content && !content.classList.contains('node-content--loading');
  }, id, { timeout });
}

test.describe('custom node types via OriginEnvoy', () => {
  test('echo custom type renders as a normal text node, children intact', async ({ page }) => {
    await page.goto('/#envoy-root');
    await waitForTree(page);

    await waitForResolved(page, 'envoy-echo-a');

    const rnInfo = await page.evaluate(() => {
      const rn = window._rvmarkFindNodes('envoy-echo-a')[0];
      const content = rn.li.querySelector(':scope > .node-content');
      return {
        // The replaced handler is the `text` type → has the permalink anchor.
        isTextHandler: !!content.querySelector('a.node-id'),
        isLoading: content.classList.contains('node-content--loading'),
        label: content.querySelector('.node-label')?.textContent ?? '',
        // A transformed node reports structure the same way any other does.
        isExpandable: content.hasAttribute('aria-expanded'),
      };
    });

    expect(rnInfo.isLoading).toBe(false);
    expect(rnInfo.isTextHandler).toBe(true);
    expect(rnInfo.label).toContain('Echo node A');
    expect(rnInfo.isExpandable).toBe(true);

    // The child survives the serialize→transform→deserialize round-trip, but a
    // node no longer carries its subtree: structure is a query, answered on
    // expand. So the round-trip is asserted where its result actually appears —
    // the mounted child — rather than on a source field that is empty by design
    // while the node is collapsed.
    await page.evaluate(() => {
      const rn = window._rvmarkFindNodes('envoy-echo-a')[0];
      rn.li.querySelector(':scope > .node-content > .toggle')?.click();
    });

    const childContent = page.locator(
      `#${await page.evaluate(() => window._rvmarkFindNodes('envoy-echo-a')[0].li.id)}`
      + ' > .node-children > ul > li.node > .node-content');
    await expect(childContent.locator('.node-label'))
      .toContainText('Echo A child survives the round-trip');
    expect(await page.evaluate(() => {
      const rn = window._rvmarkFindNodes('envoy-echo-a')[0];
      const kid = rn.li.querySelector(':scope > .node-children > ul > li.node');
      return kid?._renderNode?.sourceNode?.attrs?.get?.('id') ?? null;
    })).toBe('envoy-echo-a-child');
  });

  test('a node the client cannot render becomes an error row, page not wedged', async ({ page }) => {
    await page.goto('/#envoy-root');
    await waitForTree(page);

    await waitForResolved(page, 'envoy-missing');

    const info = await page.evaluate(() => {
      const rn = window._rvmarkFindNodes('envoy-missing')[0];
      const content = rn.li.querySelector(':scope > .node-content');
      return {
        label: content.querySelector('.node-label')?.textContent ?? '',
        hasErrorClass: content.classList.contains('node--wire-error'),
      };
    });

    // The client no longer has a concept of a custom type that "failed": an
    // origin's nodetypes are its own business and have already run. What this
    // side gets to insist on is that it can draw what it was handed, and this
    // node's type is not something it can draw.
    expect(info.label).toContain('unrenderable type');
    expect(info.label).toContain('nonexistent');
  });

  test('one sandboxed envoy iframe is created and reused for both echo nodes', async ({ page }) => {
    const consoleErrors = [];
    // Ignore the template's pre-existing CSP frame-ancestors meta warning, which
    // is unrelated to the envoy and present on every page.
    const isPreExisting = (t) => t.includes("'frame-ancestors'");
    page.on('console', (msg) => { if (msg.type() === 'error' && !isPreExisting(msg.text())) consoleErrors.push(msg.text()); });
    page.on('pageerror', (err) => consoleErrors.push(String(err)));

    await page.goto('/#envoy-root');
    await waitForTree(page);
    await waitForResolved(page, 'envoy-echo-a');
    await waitForResolved(page, 'envoy-echo-b');

    const frames = await page.evaluate(() => {
      const ifr = [...document.querySelectorAll('iframe')]
        .filter(f => (f.src || '').endsWith('/envoy.html'));
      return ifr.map(f => ({
        sandbox: f.getAttribute('sandbox'),
        hidden: getComputedStyle(f).display === 'none',
        src: f.src,
      }));
    });

    // Exactly one envoy iframe, shared by both echo nodes.
    expect(frames).toHaveLength(1);
    // Every envoy gets allow-same-origin, foreign ones included: it grants the
    // guest its OWN origin (src is always the real author-origin URL), and
    // without it a peer's relative script imports would need CORS headers its
    // static host may not offer.
    expect(frames[0].sandbox).toBe('allow-scripts allow-same-origin');
    expect(frames[0].hidden).toBe(true);
    expect(frames[0].src).toMatch(/\/envoy\.html$/);

    expect(consoleErrors).toEqual([]);
  });
});
