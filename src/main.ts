/**
 * main.ts — entry point.
 *
 * Normal mode: reads window.__RVMARK_PAGE__, loads the page's .rvmark file,
 * and renders the interactive tree. Hash fragments navigate within the page.
 *
 * Guest mode: when running inside an exhibit iframe, waits for a
 * rvmark-page-context postMessage from the host instead of reading
 * window.__RVMARK_PAGE__. This avoids inline scripts in the iframe srcdoc.
 */

import { prerootFrame } from './state.js';
import { buildRenderNode, RenderNode } from './render-node.js';
import { resolveSlugInFile, parseCompoundSlug, resolveFocusSlug } from './shared.js';
import type { SourceFile } from './source-file.js';
import { loadPageFile, setPageContext } from './loader.js';
import { setMeta, setFooter, setViewTarget, clearTree, showError } from './shell.js';
import { initSearch } from './search.js';
import { waitForPageContext, initPrerootListeners } from './iframe-guest.js';
import { MOUNT_SETTLE_MS } from './constants.js';
import { scrollBehavior } from './scroll.js';
// Side-effect imports: register all built-in types via factoryRegister
import './types/text.js';
import './markdown.js';
import './types/markdown.js';
import './types/video.js';
import './types/iframe.js';
import './types/image.js';
import './types/tr.js';
import './types/table.js';
import './types/hr.js';
import './types/gap.js';

import type { RvmarkPageContext } from './iframe-guest.js';

declare global {
  interface Window {
    __RVMARK_PAGE__?:     RvmarkPageContext;
    __RVMARK_SITE_MAP__?: Record<string, unknown>;
    __rvmarkPreroot?: {
      declare: (key: string, value: string) => void;
      set:     (key: string, value: string) => void;
      delete:  (key: string) => void;
    };
    _rvmarkFindNodes?: typeof findNodes;
  }
}

async function renderRoot(
  sourceFile:    SourceFile,
  requestedSlug: string | null,
  focusSlug:     string | null,
): Promise<void> {
  const { nodeMap, roots } = sourceFile;
  const resolved = resolveSlugInFile({ nodeMap, roots }, requestedSlug);
  const node = resolved?.node ?? roots[0] ?? null;

  if (!node) {
    showError('No content found.');
    return;
  }

  let nodePermalinkBase: string = node.attrs.get('id') || node.slug;
  if (requestedSlug && !nodeMap[requestedSlug]) {
    const { anchor, path } = parseCompoundSlug(requestedSlug);
    if (nodeMap[anchor] && path.length > 0) {
      nodePermalinkBase = `${anchor}.${path.join('.')}`;
    }
  }

  const resolvedFocusSlug = resolveFocusSlug(focusSlug, nodeMap, roots, nodePermalinkBase);

  const root = clearTree();
  const rootRn = buildRenderNode(node, resolvedFocusSlug);
  root.appendChild(rootRn.li);
  rootRn.fireConnected();
  await Promise.race([rootRn.whenReady, new Promise<void>(r => setTimeout(r, MOUNT_SETTLE_MS))]);
  const firstContent = root.querySelector('.node-content') as HTMLElement | null;
  if (firstContent && !resolvedFocusSlug) {
    const firstRn: RenderNode | undefined = (firstContent.closest<HTMLElement>('.node') as any)?._renderNode;
    if (firstRn) RenderNode.setSelection(firstRn);
  }
}

async function init(page: RvmarkPageContext): Promise<void> {
  const basePath = page.base || '';
  const staticEl = document.getElementById('static-content');
  const treeEl   = document.getElementById('tree-scroll');

  // ?--static — show the build-time static rendering that normally only
  // <noscript> readers see, and skip building the tree entirely. The static
  // <li>s carry permalinkId as their id, so any #fragment still anchors.
  // Deliberately before the fetch: this view needs nothing the interactive one
  // loads.
  if (new URLSearchParams(location.search).has('--static')) {
    if (staticEl) staticEl.style.display = 'block';
    if (treeEl) treeEl.style.display = 'none';
    if (location.hash) {
      document.getElementById(location.hash.slice(1))
        ?.scrollIntoView({ block: 'center' });
    }
    return;
  }

  let sourceFile: SourceFile;
  try {
    setPageContext(page.file, basePath);
    sourceFile = await loadPageFile(page.file, basePath);
  } catch (err) {
    console.warn(`[rvmark] Failed to load ${page.file}: ${(err as Error).message}`);
    if (staticEl) staticEl.style.display = '';
    const notice = document.createElement('p');
    notice.style.cssText = 'color:#c44;font-size:0.8rem;padding:0.4rem 1rem;position:sticky;top:0;background:var(--bg);z-index:10;';
    notice.textContent = "Couldn't load interactive features. The site isn't going to work properly.";
    staticEl?.prepend(notice);
    return;
  }

  // Engine-reserved params — they select a view, they are not page state.
  const initParams = new URLSearchParams(location.search);
  initParams.delete('focus');
  initParams.delete('--static');
  for (const [key, value] of initParams.entries()) prerootFrame.declare(key, value);

  setMeta(sourceFile.meta);
  initSearch();

  const hash  = page.anchor ?? (location.hash ? location.hash.slice(1) : null);
  const focus = page.focus  ?? new URLSearchParams(location.search).get('focus');
  await renderRoot(sourceFile, hash, focus);
  if (treeEl) treeEl.style.display = '';

  window.addEventListener('hashchange', async () => {
    const focusParam = new URLSearchParams(location.search).get('focus');
    await renderRoot(sourceFile, location.hash ? location.hash.slice(1) : null, focusParam);
    document.getElementById('tree-scroll')?.scrollTo({ top: 0, behavior: scrollBehavior() });
  });

  const treeRoot = document.getElementById('tree-root') as HTMLElement;
  treeRoot.addEventListener('rvmark-select', (e) => {
    setFooter((e as CustomEvent).detail.meta);
    setViewTarget(RenderNode.currentSelection);
  });
  treeRoot.addEventListener('rvmark-deselect', () => {
    // Reset to page-level meta. On a normal A→B move this runs first and the
    // paired rvmark-select immediately overwrites it (same JS turn, one paint,
    // no flash). When selection goes to nothing, no select follows and the
    // page-meta footer stands.
    setFooter(null);
    setViewTarget(null);
  });

  window.addEventListener('message', (e: MessageEvent) => {
    if (e.origin !== window.location.origin) return;
    if (e.data?.type === 'exhibit-meta') setFooter(e.data.meta);
  });
}

export function findNodes(query: string): RenderNode[] {
  const results: RenderNode[] = [];
  for (const li of document.querySelectorAll<HTMLElement>('li.node')) {
    const rn: RenderNode | undefined = (li as any)._renderNode;
    if (!rn) continue;
    const sn = rn.sourceNode;
    if (
      sn.slug === query ||
      sn.attrs?.get('id') === query ||
      (sn.sourceFile?.pageAddress && sn.slug && sn.sourceFile.pageAddress + '#' + sn.slug === query)
    ) results.push(rn);
  }
  return results;
}

if (typeof window !== 'undefined' && typeof window.document !== 'undefined') {
  const preroot = {
    declare:        (key: string, value: string) => prerootFrame.declare(key, value),
    set:            (key: string, value: string) => prerootFrame.set(key, value),
    delete:         (key: string)                => prerootFrame.delete(key),
    enableRelay:    (fn: (op: 'declare' | 'set' | 'delete', key: string, value?: string) => void) => prerootFrame.enableRelay(fn),
    applyFromHost:  (key: string, value: string | undefined) => prerootFrame.applyFromHost(key, value),
  };
  window.__rvmarkPreroot = preroot;
  window._rvmarkFindNodes = findNodes;

  if (window.parent !== window) initPrerootListeners(preroot);
  const page = window.__RVMARK_PAGE__;
  if (page) init(page);
  else waitForPageContext().then(ctx => init(ctx));
}
