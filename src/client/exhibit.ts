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
 * Selection scoping: {exhibit} is an inherited property (inherited.ts), resolved
 * down the source tree at parse time. Selecting any node under a declaring node
 * keeps that exhibit up; selecting one with no exhibit in force blanks the panel.
 * Because scope comes from the source tree, a node transcluded elsewhere carries
 * its own document's exhibit rather than adopting its host's.
 * notifySelection(content) must be called whenever selection changes.
 */

import { mdToHtml } from './markdown.js';
import { getPageContext } from './page-context.js';

import { addressToHref } from '../shared/shared.js';
import { originFor, addressOf, resolveRefAt } from '../envoy/origin.js';
import { parsePass } from './handler-utils.js';
import { prerootFrame, StateRelay, buildStatePass } from './state.js';
import { postGuestMode, broadcastPreroot, prerootDeclareMsg, prerootSetMsg, prerootDeleteMsg, wireRelay, registerThemeIframe, unregisterThemeIframe } from './iframe-host.js';
import { RenderNode } from './render-node.js';
import type { NodeAttrs, SourceNode } from '../shared/parser.js';

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
  //
  // The × is drawn, not typed. As a character (U+00D7) it is centred on its
  // typographic metrics rather than its ink: the multiplication sign aligns
  // with digits and operators, sitting on the maths axis above the middle of
  // the line box, so centring the box still leaves the mark visibly high — and
  // by a different amount in every font the button might inherit. Two lines
  // through the middle of a square viewBox are centred by construction, are
  // identical on every platform, and scale with the button rather than with the
  // font stack.
  const closeBtn = document.createElement('button');
  closeBtn.className = 'exhibit-close';
  closeBtn.innerHTML =
    '<svg viewBox="0 0 16 16" aria-hidden="true">' +
    '<path d="M4.5 4.5 11.5 11.5M11.5 4.5 4.5 11.5"/></svg>';
  closeBtn.title = 'Close exhibit (Escape)';
  // The glyph carried the accessible name while it was text; an aria-hidden
  // drawing carries none, so it is stated.
  closeBtn.setAttribute('aria-label', 'Close exhibit');
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
    // Two spans, not one string: the state applies everywhere, but the Escape
    // instruction is keyboard-only and is hidden on coarse pointers, where the
    // × button is the obvious affordance. See .exhibit-hint-key in styles.css.
    const state = document.createElement('span');
    state.textContent = 'No exhibit active.';
    const key = document.createElement('span');
    key.className = 'exhibit-hint-key';
    key.textContent = 'Press Esc to close.';
    hint.append(state, key);
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

// `triggerRn` is the node the reader acted on — selected, clicked, or activated.
// The selected node already determines WHICH exhibit is shown; it determines the
// state the exhibit sees for the same reason. {exhibit-pass} binds its variables
// in that node's frame, resolving names up the frame chain exactly as
// {show-when} and {on-action} do on any node — ordinary lexical scoping, with a
// nearer `let` winning over an outer one.
//
// This is also the only well-defined choice: {exhibit} is inherited down the
// source tree, so a node can hold an exhibit whose declaring ancestor was never
// rendered and therefore has no frame to bind against.
export async function exhibitOpen(
  rawRef:         string,
  sourceFileAddress: string,
  triggerRn:      RenderNode | null,
  attrs:          NodeAttrs,
): Promise<void> {
  // Already showing this trigger — nothing to do.
  if (triggerRn && _currentTriggerRn === triggerRn) return;

  // Same exhibit target, different node under the same scope — keep the iframe
  // in place and only rewire the state relay to that node's frame.
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

// The exhibit in force for a node. Inherited down the source tree at parse time
// (inherited.ts), so this is a field read — no walk over rendered ancestors.
//
// A node's exhibit is the one its own document declared over it. The DOM walk
// this replaced derived scope from where a subtree landed instead, so content
// transcluded into a page picked up that page's exhibit rather than its own.
// Exported for tests: it reads only `sourceNode`, so it is exercisable without
// a DOM. Callers in this module pass a real RenderNode.
export function exhibitConfigOf(rn: { sourceNode: SourceNode }): ExhibitConfig | null {
  const scope = rn.sourceNode.exhibit;
  if (!scope) return null;
  return {
    rawRef:            scope.rawRef,
    // Inheritance never crosses a file, so this node's file is the one that
    // declared the scope — which is what the ref resolves against.
    sourceFileAddress: rn.sourceNode.pageAddress,
    attrs:             scope.attrs,
  };
}

// Called by the renderer whenever selection changes.
// Loads the nearest enclosing exhibit scope for the new selection.
// Blanks the panel if no exhibit scope is found.
export function exhibitNotifySelection(selectedRn: RenderNode): void {
  if (!_panel) return;
  const config = exhibitConfigOf(selectedRn);
  if (!config) { _blankPanel(); return; }
  exhibitOpen(config.rawRef, config.sourceFileAddress, selectedRn, config.attrs);
}

// ── Renderer interface ─────────────────────────────────────────────────────

// Open the exhibit panel for the exhibit in force at rn.
//
// An explicit open — {action: exhibit}, or the keyboard equivalent — always
// opens the panel, even where no exhibit is in force. The reader asked for the
// panel; showing it empty ("No exhibit active") answers them, whereas doing
// nothing looks like a broken control. Only selection-driven updates
// (exhibitNotifySelection) leave a closed panel closed.
export function exhibitOpenFromNode(rn: RenderNode): void {
  const config = exhibitConfigOf(rn);
  if (!config) { _ensurePanel(); _blankPanel(); return; }
  void exhibitOpen(config.rawRef, config.sourceFileAddress, rn, config.attrs);
}

// ── Shared head builder ───────────────────────────────────────────────────────

function exhibitHead(basePath: string): string {
  return `
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <!-- No webfonts here either — see the note in template.html. -->
  <link rel="stylesheet" href="${basePath}styles.css">
  <!-- No KaTeX here either — exhibits run the engine, so ensureKatex() fetches
       it on demand if the exhibited content actually contains math. -->
  <script type="module" src="${basePath}_engine/client/iframe-guest.js"><\/script>`;
}

// ── Strategy: rvmark tree ─────────────────────────────────────────────────────

class RvmarkExhibitStrategy extends ExhibitStrategy {
  async build(rawRef: string, sourceFileAddress: string): Promise<ExhibitResult | null> {
    const node = await resolveRefAt(addressOf(sourceFileAddress), rawRef);
    if (!node) return null;

    // Build the address from the resolved node's own source file rather than
    // re-resolving rawRef — this is the path that handles sigil refs (which
    // resolveAddress doesn't understand) and cross-origin federation.
    const fileAddress = node.pageAddress;
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
    const from = addressOf(sourceFileAddress);
    const fullPath = originFor(from.baseUrl).resolveResource(from.key, rawRef) ?? rawRef;
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
    const from = addressOf(sourceFileAddress);
    const fullPath = originFor(from.baseUrl).resolveResource(from.key, rawRef) ?? rawRef;
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
