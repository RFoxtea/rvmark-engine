/**
 * federation.spec.js — end-to-end tests for cross-origin transclusion.
 *
 * Setup: two http-server instances serving the same engine/tests/dist:
 *   - port 8002 (primary, used as page origin)
 *   - port 8003 (peer, with CORS enabled)
 *
 * The fixture engine/tests/rvmark/federation-test.rvmark declares
 *   @peer {url: http://localhost:8003}
 * and uses sigil refs like {=> @peer/federation-target#deep}.
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

async function waitForNode(page, id, timeout = 3000) {
  await page.waitForFunction((id) => {
    const rns = window._rvmarkFindNodes?.(id);
    return !!(rns?.[0]?.li?.id);
  }, id, { timeout });
}

test.describe('cross-origin transclusion via origin sigils', () => {
  test('sigil ref to peer renders peer content', async ({ page }) => {
    await page.goto('/federation-test/');
    await waitForTree(page);
    // {#child-peer-embed; open; => @peer/federation-target} expands to the
    // peer's root's children. {#peer-child} is one of them.
    await waitForNode(page, 'peer-child');
  });

  test('sigil ref with anchor renders the targeted subtree', async ({ page }) => {
    await page.goto('/federation-test/');
    await waitForTree(page);
    // @peer/federation-target#deep targets {#deep}, whose child is {#deep-child}.
    await waitForNode(page, 'deep-child');
  });

  test('undeclared sigil warns to console', async ({ page }) => {
    const warnings = [];
    page.on('console', msg => {
      if (msg.type() === 'warning') warnings.push(msg.text());
    });
    await page.goto('/federation-test/');
    await waitForTree(page);
    // The undeclared-sigil node is `open`, forcing an immediate resolve attempt.
    await page.waitForTimeout(500);
    const undeclaredWarning = warnings.find(w => w.includes('@undeclared'));
    expect(undeclaredWarning).toBeTruthy();
  });

  test('permalink for a transcluded peer node points to the peer origin', async ({ page }) => {
    await page.goto('/federation-test/');
    await waitForTree(page);
    await waitForNode(page, 'peer-child');
    const href = await page.evaluate(() => {
      const rns = window._rvmarkFindNodes?.('peer-child');
      const anchor = rns?.[0]?.li?.querySelector('.node-id');
      return anchor?.getAttribute('href');
    });
    expect(href).toMatch(/^http:\/\/localhost:8003\/federation-target/);
  });

  test('peer content is fetched cross-origin from port 8003', async ({ page }) => {
    const peerRequests = [];
    page.on('request', req => {
      if (req.url().startsWith('http://localhost:8003')) peerRequests.push(req.url());
    });
    await page.goto('/federation-test/');
    await waitForTree(page);
    await waitForNode(page, 'peer-child');
    expect(peerRequests.some(u => u.includes('federation-target.rvmark'))).toBe(true);
  });
});
