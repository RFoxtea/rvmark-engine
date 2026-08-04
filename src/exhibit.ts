/**
 * exhibit.ts
 *
 * Exhibit panel manager. Nodes with {exhibit: ./path#slug} open rich content
 * in a side panel for joint attention — the tree presents something for the
 * reader to contemplate alongside it.
 *
 * Each exhibit runs inside an iframe — a completely separate DOM universe.
 * This gives true isolation: no leaked queries, no shared focus/selection
 * state, no event bubbling across boundaries. The only communication channel
 * is postMessage (used for Escape-to-close).
 *
 * Strategies determine how the iframe content is built:
 *   - rvmark: a full rvmark page with its own parser/renderer/tree
 *   - markdown: a styled rendered .md file
 *   - html: a raw HTML file, overflow controlled by {overflow: …} param
 *
 * Nodes with {action: exhibit} open the exhibit on select-then-reclick; that
 * wiring is done by the type handlers via wireSelectThenAction, which calls
 * exhibitOpenFromNode. Keyboard activation goes through actionKeydown.
 *
 * Selection scoping: when selection moves outside the subtree of the node
 * that opened the exhibit, the exhibit closes automatically.
 * notifySelection(content) must be called whenever selection changes.
 */

import { mdToHtml } from './markdown.js';
import { getPageContext } from './loader.js';
import { resolveRef } from './transclusion.js';
import { resolveMediaAddress, addressToHref } from './shared.js';
import { parsePass } from './handler-utils.js';
import { prerootFrame, StateRelay, buildStatePass } from './state.js';
import { postGuestMode, broadcastPreroot, prerootDeclareMsg, prerootSetMsg, prerootDeleteMsg, wireRelay, registerThemeIframe, unregisterThemeIframe } from './iframe-host.js';
import { RenderNode } from './render-node.js';
import type { NodeAttrs } from './parser.js';

export interface ExhibitConfig {
  rawRef:            string;
  sourceFileAddress: string;
  attrs:             NodeAttrs;
}

interface ExhibitResult {
  title: string;
  /** srcdoc HTML — used by markdown/html strategies. */
  html?: string;
  /** Page URL — used by rvmark strategy; sets iframe.src directly. */
  url?: string;
  /**
   * Whether the iframe content is trusted as same-origin. For `url`, derived
   * automatically from the URL's origin. For `srcdoc`, the strategy must set
   * this — true when the srcdoc was built from sanitized/local content,
   * false when it inlines raw remote HTML.
   */
  trusted?: boolean;
}

const _exhibitStrategies = new Map<string, ExhibitStrategy>();

// State: one persistent panel, one trigger .node-content, one content cleanup.
// The panel is created on first open and destroyed only when the user explicitly
// closes it (× button or Escape). While it exists, body.exhibit-open is true.
//
// Scope rule: when selection moves outside the subtree of the trigger node,
// the panel is blanked but stays open.
let _panel:              HTMLElement | null = null;
let _currentTriggerRn:   RenderNode | null = null;
let _currentRefString:   string | null = null;
let _currentCleanup:     (() => void) | null = null;
// Cleanup for the current relay wiring. Promoted from _buildIframe's closure
// so exhibitOpen() can rewire to a new relay when the scope changes but the
// exhibit target stays the same.
let _relayCleanup:       (() => void) | null = null;

export class ExhibitStrategy {
  async build(_rawRef: string, _sourceFileAddress: string, _attrs?: NodeAttrs): Promise<ExhibitResult | null> {
    return null;
  }
}

export function exhibitRegister(name: string, strategy: ExhibitStrategy): void {
  _exhibitStrategies.set(name, strategy);
}

function strategyFor(refString: string | null): string {
  if (!refString) return 'rvmark';
  const hashIdx = refString.indexOf('#');
  const pathPart = hashIdx !== -1 ? refString.slice(0, hashIdx) : refString;
  if (pathPart.endsWith('.md')) return 'markdown';
  if (pathPart.endsWith('.html')) return 'html';
  return 'rvmark';
}

function _ensurePanel(): void {
  if (_panel) return;
  _panel = document.createElement('div');
  _panel.className = 'exhibit-panel';
  // Add the close button once; it lives for the _panel's lifetime.
  const closeBtn = document.createElement('button');
  closeBtn.className = 'exhibit-close';
  closeBtn.textContent = '×';
  closeBtn.title = 'Close exhibit (Escape)';
  closeBtn.tabIndex = -1;
  closeBtn.addEventListener('click', () => exhibitClose());
  _panel.appendChild(closeBtn);
  const root = document.getElementById('root');
  const footer = root?.querySelector('footer');
  if (footer) root!.insertBefore(_panel, footer);
  else root?.appendChild(_panel);
  document.body.classList.add('exhibit-open');
}

// Clear iframe/error content from the panel, leaving only the close button.
// Shows a muted "Press esc to close." hint when idle (no exhibit active).
function _blankPanel({ showHint = true }: { showHint?: boolean } = {}): void {
  if (!_panel) return;
  _currentCleanup?.();
  _currentCleanup        = null;
  _relayCleanup?.();
  _relayCleanup          = null;
  _currentTriggerRn      = null;
  _currentRefString      = null;
  // Remove everything except the close button.
  for (const child of [..._panel.children]) {
    if (!child.classList.contains('exhibit-close')) child.remove();
  }
  if (showHint) {
    const hint = document.createElement('div');
    hint.className = 'exhibit-hint';
    hint.textContent = 'No exhibit active.\nPress Esc to close.';
    _panel.appendChild(hint);
  }
}

function _showError(msg: string): void {
  _blankPanel({ showHint: false });
  const div = document.createElement('div');
  div.className = 'exhibit-error';
  div.textContent = msg;
  _panel!.appendChild(div);
}

function _exhibitIframes(): HTMLIFrameElement[] {
  return _panel ? [..._panel.querySelectorAll<HTMLIFrameElement>('.exhibit-iframe')] : [];
}

function _buildIframe(result: ExhibitResult, relay: StateRelay | null, passEntries: ReturnType<typeof parsePass>): HTMLIFrameElement {
  const iframe = document.createElement('iframe');
  iframe.className = 'exhibit-iframe';
  _panel!.appendChild(iframe);
  iframe.addEventListener('load', () => {
    if (iframe.contentWindow) {
      registerThemeIframe(iframe.contentWindow);
      postGuestMode(iframe.contentWindow, 'rvmark-exhibit-guest');
      _relayCleanup?.();
      _relayCleanup = relay ? wireRelay(relay, passEntries, iframe.contentWindow) : null;
    }
  });
  // Same-origin trust: an explicit `trusted` flag from the strategy wins;
  // otherwise derive it from result.url's origin. srcdoc with no flag defaults
  // to untrusted.
  const trusted = result.trusted ?? (result.url ? (() => {
    try { return new URL(result.url!, window.location.href).origin === window.location.origin; }
    catch { return false; }
  })() : false);
  if (!trusted) iframe.setAttribute('sandbox', 'allow-scripts');
  if (result.url) {
    iframe.src = result.url;
  } else {
    iframe.srcdoc = result.html!;
  }
  new MutationObserver((_, obs) => {
    if (!iframe.isConnected) {
      if (iframe.contentWindow) unregisterThemeIframe(iframe.contentWindow);
      _relayCleanup?.();
      _relayCleanup = null;
      obs.disconnect();
    }
  }).observe(document.body, { childList: true, subtree: true });
  return iframe;
}

export function prerootDeclare(key: string, value: string): void {
  prerootFrame.declare(key, value);
  broadcastPreroot(_exhibitIframes(), prerootDeclareMsg(key, value));
}

export function prerootSet(key: string, value: string): void {
  prerootFrame.set(key, value);
  broadcastPreroot(_exhibitIframes(), prerootSetMsg(key, value));
}

export function prerootDelete(key: string): void {
  prerootFrame.delete(key);
  broadcastPreroot(_exhibitIframes(), prerootDeleteMsg(key));
}

export async function exhibitOpen(
  rawRef:         string,
  sourceFileAddress: string,
  triggerRn:      RenderNode | null,
  attrs:          NodeAttrs,
): Promise<void> {
  // Already showing this trigger — nothing to do.
  if (triggerRn && _currentTriggerRn === triggerRn) return;

  // Same exhibit target from a different scope node — keep the iframe in
  // place and only rewire the state relay to the new scope's frame.
  if (triggerRn && _currentRefString === rawRef && _panel) {
    const iframe = _panel.querySelector<HTMLIFrameElement>('.exhibit-iframe');
    const win    = iframe?.contentWindow ?? null;
    const exhibitPassRaw = attrs.get('exhibit-pass') ?? null;
    const passEntries    = exhibitPassRaw ? parsePass(exhibitPassRaw) : [];
    const relay = exhibitPassRaw
      ? new StateRelay(buildStatePass(triggerRn.state, passEntries))
      : null;
    _relayCleanup?.();
    _relayCleanup = (relay && win) ? wireRelay(relay, passEntries, win) : null;
    _currentTriggerRn = triggerRn;
    return;
  }

  _ensurePanel();
  _blankPanel({ showHint: false }); // clear previous content before loading new

  const name = strategyFor(rawRef);
  const strategy = _exhibitStrategies.get(name);
  if (!strategy) {
    _showError(`No exhibit strategy for '${name}'.`);
    _currentTriggerRn = triggerRn;
    return;
  }

  let result: ExhibitResult | null;
  try {
    result = await strategy.build(rawRef, sourceFileAddress, attrs);
  } catch (err) {
    _showError(`Exhibit failed to load: ${(err as Error).message}`);
    _currentTriggerRn = triggerRn;
    return;
  }
  if (!result) {
    _showError(`Exhibit not found: ${rawRef}`);
    _currentTriggerRn = triggerRn;
    return;
  }

  const exhibitPassRaw = attrs.get('exhibit-pass') ?? null;
  const passEntries = exhibitPassRaw ? parsePass(exhibitPassRaw) : [];
  const relay = (exhibitPassRaw && triggerRn)
    ? new StateRelay(buildStatePass(triggerRn.state, passEntries))
    : null;

  const iframe = _buildIframe(result, relay, passEntries);

  const onMessage = (e: MessageEvent) => {
    if (e.source !== iframe.contentWindow) return;
    if (e.data?.type === 'rvmark-escape') exhibitClose();
  };
  window.addEventListener('message', onMessage);

  _currentTriggerRn  = triggerRn;
  _currentRefString  = rawRef;
  _currentCleanup    = () => window.removeEventListener('message', onMessage);
}

// Explicitly close the panel (user action). Removes _panel from DOM entirely.
export function exhibitClose(): void {
  if (!_panel) return;
  _currentCleanup?.();
  _panel.remove();
  _panel             = null;
  _currentTriggerRn  = null;
  _currentRefString  = null;
  _currentCleanup    = null;
  document.body.classList.remove('exhibit-open');
}

export function exhibitIsOpen(): boolean {
  return _panel !== null;
}

export function exhibitCurrentTrigger(): RenderNode | null {
  return _currentTriggerRn;
}

// Walk up from selectedRn through ancestor RenderNodes, looking for one with
// an exhibitConfig. Stops when the source file changes (cross-document boundary).
function _nearestExhibitRn(selectedRn: RenderNode): RenderNode | null {
  const originFile = selectedRn.sourceNode.sourceFile?.pageAddress;
  let li: HTMLElement | null = selectedRn.li;
  while (li) {
    const rn: RenderNode | undefined = (li as any)._renderNode;
    if (rn && rn.sourceNode.sourceFile?.pageAddress !== originFile) break;
    if (rn?.exhibitConfig) return rn;
    li = li.parentElement?.closest<HTMLElement>('.node') ?? null;
  }
  return null;
}

// Called by the renderer whenever selection changes.
// Loads the nearest enclosing exhibit scope for the new selection.
// Blanks the panel if no exhibit scope is found.
export function exhibitNotifySelection(selectedRn: RenderNode): void {
  if (!_panel) return;
  const nearest = _nearestExhibitRn(selectedRn);
  if (!nearest) { _blankPanel(); return; }
  if (nearest === _currentTriggerRn) return; // already showing it
  const { rawRef, sourceFileAddress, attrs } = nearest.exhibitConfig!;
  exhibitOpen(rawRef, sourceFileAddress, nearest, attrs);
}

// ── Renderer interface ─────────────────────────────────────────────────────

// Called for nodes with {exhibit: …}. Sets exhibitConfig on the RenderNode so
// _nearestExhibitRn can find the nearest enclosing scope when selection changes.
export function exhibitStampScope(
  rn:                RenderNode,
  rawRef:            string,
  sourceFileAddress: string,
  attrs:             NodeAttrs,
): void {
  rn.exhibitConfig = { rawRef, sourceFileAddress, attrs };
}

// Open the exhibit panel for the nearest enclosing exhibit scope of rn.
// No-op if no scope is found.
export function exhibitOpenFromNode(rn: RenderNode): void {
  const scopeRn = _nearestExhibitRn(rn);
  if (!scopeRn) return;
  const { rawRef, sourceFileAddress, attrs } = scopeRn.exhibitConfig!;
  void exhibitOpen(rawRef, sourceFileAddress, scopeRn, attrs);
}

// Called for nodes with {action: exhibit}.
// Wires label click to open the _panel. Toggle (bullet) keeps its expand/collapse
// behavior, wired by the type handler. Keydown is handled centrally via actionKeydown.
// Uses the nearest enclosing exhibitConfig (which may be on this node or an ancestor).
// ── Shared head builder ───────────────────────────────────────────────────────

function exhibitHead(basePath: string): string {
  return `
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <!-- No webfonts here either — see the note in template.html. -->
  <link rel="stylesheet" href="${basePath}styles.css">
  <!-- No KaTeX here either — exhibits run the engine, so ensureKatex() fetches
       it on demand if the exhibited content actually contains math. -->
  <script type="module" src="${basePath}_engine/iframe-guest.js"><\/script>`;
}

// ── Strategy: rvmark tree ─────────────────────────────────────────────────────

class RvmarkExhibitStrategy extends ExhibitStrategy {
  async build(rawRef: string, sourceFileAddress: string): Promise<ExhibitResult | null> {
    const node = await resolveRef(rawRef, sourceFileAddress);
    if (!node) return null;

    // Build the address from the resolved node's own source file rather than
    // re-resolving rawRef — this is the path that handles sigil refs (which
    // resolveAddress doesn't understand) and cross-origin federation.
    const fileAddress = node.sourceFile?.pageAddress;
    if (!fileAddress) return null;
    const address = node.permalinkId ? `${fileAddress}#${node.permalinkId}` : fileAddress;

    return { title: node.label || '', url: addressToHref(address) };
  }
}
exhibitRegister('rvmark', new RvmarkExhibitStrategy());


// ── Strategy: markdown ────────────────────────────────────────────────────────

class MarkdownExhibitStrategy extends ExhibitStrategy {
  async build(rawRef: string, sourceFileAddress: string): Promise<ExhibitResult | null> {
    const ctx = getPageContext();
    const fullPath = resolveMediaAddress(rawRef, sourceFileAddress) ?? rawRef;
    const basePath = ctx.basePath;

    let text: string;
    try {
      const res = await fetch(fullPath, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      text = await res.text();
    } catch (_) {
      return null;
    }

    const renderedHtml = mdToHtml(text);
    const displayName = fullPath.split('/').pop()!.replace(/\.md$/, '');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
${exhibitHead(basePath)}
<style>
  html, body {
    padding: 0;
    overflow-x: hidden;
    overflow-y: auto;
    min-height: 100%;
  }
  .md-body {
    margin-left: 0;
    padding: 1.2rem 1.4rem;
    border-left: none;
    max-width: none;
    max-height: none;
    overflow-y: visible;
  }
  .md-body:focus { outline: none; }
</style>
</head>
<body>
<div class="md-body" tabindex="0">
  ${renderedHtml}
</div>
</body>
</html>`;

    return { title: displayName, html, trusted: true };
  }
}
exhibitRegister('markdown', new MarkdownExhibitStrategy());


// ── Strategy: html ────────────────────────────────────────────────────────────

class HtmlExhibitStrategy extends ExhibitStrategy {
  async build(rawRef: string, sourceFileAddress: string, attrs?: NodeAttrs): Promise<ExhibitResult | null> {
    const fullPath = resolveMediaAddress(rawRef, sourceFileAddress) ?? rawRef;
    const displayName = fullPath.split('/').pop()!.replace(/\.html$/, '');

    // Same-origin (or path-only build-time) HTML: load via iframe.src so the
    // page runs in its own origin with full access to its assets. Cross-origin
    // HTML is fetched and wrapped in srcdoc (sandboxed by _buildIframe).
    const isSameOrigin = !fullPath.startsWith('http') || (() => {
      try { return new URL(fullPath).origin === window.location.origin; }
      catch { return false; }
    })();
    if (isSameOrigin) {
      return { title: displayName, url: addressToHref(fullPath) };
    }

    const ctx = getPageContext();
    const basePath = ctx.basePath;

    let text: string;
    try {
      const res = await fetch(fullPath, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      text = await res.text();
    } catch (_) {
      return null;
    }

    const overflow = attrs?.get('overflow') ?? 'auto';

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
${exhibitHead(basePath)}
<style>
  html, body {
    padding: 0;
    margin: 0;
    overflow: ${overflow};
    height: ${overflow === 'hidden' ? '100%' : 'auto'};
  }
  body {
    padding: 1rem;
    font-family: var(--mono, monospace);
    font-size: 0.88rem;
    line-height: 1.6;
    color: var(--fg);
  }
</style>
</head>
<body>
${text}
</body>
</html>`;

    return { title: displayName, html };
  }
}
exhibitRegister('html', new HtmlExhibitStrategy());
