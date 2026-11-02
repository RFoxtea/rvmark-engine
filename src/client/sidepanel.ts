/**
 * sidepanel.ts
 *
 * Sidepanel manager. Nodes with {sidepanel: ./path#slug} open rich content
 * in a side panel for joint attention — the tree presents something for the
 * reader to contemplate alongside it.
 *
 * Each sidepanel runs inside an iframe — a completely separate DOM universe.
 * This gives true isolation: no leaked queries, no shared focus/selection
 * state, no event bubbling across boundaries. The only communication channel
 * is postMessage (used for Escape-to-close).
 *
 * Strategies determine how the iframe content is built:
 *   - rvmark: a full rvmark page with its own parser/renderer/tree
 *   - html: an HTML file, loaded at its own origin
 *
 * Nodes with {action: sidepanel} open the sidepanel on select-then-reclick; that
 * wiring is done by the type handlers via wireSelectThenAction, which calls
 * sidepanelOpenFromNode. Keyboard activation goes through actionKeydown.
 *
 * Selection scoping: {sidepanel} is an inherited property (inherited.ts), resolved
 * down the source tree at parse time. Selecting any node under a declaring node
 * keeps that sidepanel up; selecting one with no sidepanel in force blanks the panel.
 * Because scope comes from the source tree, a node transcluded elsewhere carries
 * its own document's sidepanel rather than adopting its host's.
 * notifySelection(content) must be called whenever selection changes.
 */

import { addressToHref, isRvFile } from '../shared/shared.js';
import { originFor, addressOf, resolveRefAt } from './origin-host.js';
import { parsePass } from './handler-utils.js';
import { prerootFrame, StateRelay, buildStatePass } from './state.js';
import { postGuestMode, broadcastPreroot, prerootDeclareMsg, prerootSetMsg, prerootDeleteMsg, wireRelay, registerThemeIframe, unregisterThemeIframe } from './iframe-host.js';
import { RenderNode } from './render-node.js';
import { sidepanelSplitAttach, sidepanelSplitDetach } from './sidepanel-split.js';
import type { NodeAttrs, RvNode } from '../shared/parser.js';

export interface SidepanelConfig {
  rawRef:            string;
  sourceFileAddress: string;
  attrs:             NodeAttrs;
}

interface SidepanelResult {
  title: string;
  url:   string;
}

const _sidepanelStrategies = new Map<string, SidepanelStrategy>();

// State: one persistent panel, one trigger .node-content, one content cleanup.
// The panel is created on first open and destroyed only when the user explicitly
// closes it (× button or Escape). While it exists, body.sidepanel-open is true.
//
// Scope rule: when selection moves outside the subtree of the trigger node,
// the panel is blanked but stays open.
let _panel:              HTMLElement | null = null;
let _currentTriggerRn:   RenderNode | null = null;
let _currentRefKey:      string | null = null;
let _currentCleanup:     (() => void) | null = null;
// Cleanup for the current relay wiring. Promoted from _buildIframe's closure
// so sidepanelOpen() can rewire to a new relay when the scope changes but the
// sidepanel target stays the same.
let _relayCleanup:       (() => void) | null = null;

export class SidepanelStrategy {
  async build(_rawRef: string, _sourceFileAddress: string, _attrs?: NodeAttrs): Promise<SidepanelResult | null> {
    return null;
  }
}

export function sidepanelRegister(name: string, strategy: SidepanelStrategy): void {
  _sidepanelStrategies.set(name, strategy);
}

function strategyFor(refString: string | null): string {
  if (!refString) return 'rvmark';
  const hashIdx = refString.indexOf('#');
  const pathPart = hashIdx !== -1 ? refString.slice(0, hashIdx) : refString;
  if (isRvFile(pathPart)) return 'rvmark';
  if (pathPart.endsWith('.md')) return 'markdown';
  if (pathPart.endsWith('.html')) return 'html';
  return 'rvmark';
}

function _ensurePanel(): void {
  if (_panel) return;
  _panel = document.createElement('div');
  _panel.className = 'sidepanel';
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
  closeBtn.className = 'sidepanel-close';
  closeBtn.innerHTML =
    '<svg viewBox="0 0 16 16" aria-hidden="true">' +
    '<path d="M4.5 4.5 11.5 11.5M11.5 4.5 4.5 11.5"/></svg>';
  closeBtn.title = 'Close sidepanel (Escape)';
  // The glyph carried the accessible name while it was text; an aria-hidden
  // drawing carries none, so it is stated.
  closeBtn.setAttribute('aria-label', 'Close sidepanel');
  closeBtn.tabIndex = -1;
  closeBtn.addEventListener('click', () => sidepanelClose());
  _panel.appendChild(closeBtn);
  const root = document.getElementById('root');
  const footer = root?.querySelector('footer');
  if (footer) root!.insertBefore(_panel, footer);
  else root?.appendChild(_panel);
  document.body.classList.add('sidepanel-open');
  // After the class, so the grid the split writes tracks onto is the one the
  // stylesheet's sidepanel-open rules established.
  void sidepanelSplitAttach();
}

// Clear iframe/error content from the panel, leaving only the close button.
// Shows a muted "Press esc to close." hint when idle (no sidepanel active).
function _blankPanel({ showHint = true }: { showHint?: boolean } = {}): void {
  if (!_panel) return;
  _currentCleanup?.();
  _currentCleanup        = null;
  _relayCleanup?.();
  _relayCleanup          = null;
  _currentTriggerRn      = null;
  _currentRefKey         = null;
  // Remove everything except the close button.
  for (const child of [..._panel.children]) {
    if (!child.classList.contains('sidepanel-close')) child.remove();
  }
  if (showHint) {
    const hint = document.createElement('div');
    hint.className = 'sidepanel-hint';
    // Two spans, not one string: the state applies everywhere, but the Escape
    // instruction is keyboard-only and is hidden on coarse pointers, where the
    // × button is the obvious affordance. See .sidepanel-hint-key in styles.css.
    const state = document.createElement('span');
    state.textContent = 'No sidepanel active.';
    const key = document.createElement('span');
    key.className = 'sidepanel-hint-key';
    key.textContent = 'Press Esc to close.';
    hint.append(state, key);
    _panel.appendChild(hint);
  }
}

function _showError(msg: string): void {
  _blankPanel({ showHint: false });
  const div = document.createElement('div');
  div.className = 'sidepanel-error';
  div.textContent = msg;
  _panel!.appendChild(div);
}

function _sidepanelIframes(): HTMLIFrameElement[] {
  return _panel ? [..._panel.querySelectorAll<HTMLIFrameElement>('.sidepanel-iframe')] : [];
}

function _buildIframe(result: SidepanelResult, relay: StateRelay | null, passEntries: ReturnType<typeof parsePass>): HTMLIFrameElement {
  const iframe = document.createElement('iframe');
  iframe.className = 'sidepanel-iframe';
  _panel!.appendChild(iframe);
  iframe.addEventListener('load', () => {
    if (iframe.contentWindow) {
      registerThemeIframe(iframe.contentWindow);
      postGuestMode(iframe.contentWindow, 'rvmark-sidepanel-guest');
      _relayCleanup?.();
      _relayCleanup = relay ? wireRelay(relay, passEntries, iframe.contentWindow) : null;
    }
  });
  // `allow-same-origin` does not mean "same origin as this page" — it means the
  // document is not forced into an opaque origin. With `src` at a foreign URL
  // that origin is the peer's, never ours, so the flag grants the page its own
  // cookies, storage and relative asset loads and grants it nothing here. That
  // is the same trade origin-host.ts makes for an envoy, and it is what an
  // opaque origin costs: relative subresources become cross-origin requests the
  // peer's own server never agreed to serve.
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-downloads');
  iframe.src = result.url;
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
  broadcastPreroot(_sidepanelIframes(), prerootDeclareMsg(key, value));
}

export function prerootSet(key: string, value: string): void {
  prerootFrame.set(key, value);
  broadcastPreroot(_sidepanelIframes(), prerootSetMsg(key, value));
}

export function prerootDelete(key: string): void {
  prerootFrame.delete(key);
  broadcastPreroot(_sidepanelIframes(), prerootDeleteMsg(key));
}

// Cache key for "is this the same sidepanel target?". A ref is relative to the
// file that declares it, so the pair is what identifies a target, not the ref
// alone. Cheap and synchronous — the strategies do the real resolution when
// they load, and a key that only ever compares equal to itself is harmless.
function refKeyFor(rawRef: string, sourceFileAddress: string): string {
  try {
    return new URL(rawRef, `file:///${sourceFileAddress}`).pathname;
  } catch {
    return `${sourceFileAddress}\u0000${rawRef}`;
  }
}

// `triggerRn` is the node the reader acted on — selected, clicked, or activated.
// The selected node already determines WHICH sidepanel is shown; it determines the
// state the sidepanel sees for the same reason. {sidepanel-pass} binds its variables
// in that node's frame, resolving names up the frame chain exactly as
// {show-when} and {on-action} do on any node — ordinary lexical scoping, with a
// nearer `let` winning over an outer one.
//
// This is also the only well-defined choice: {sidepanel} is inherited down the
// source tree, so a node can hold a sidepanel whose declaring ancestor was never
// rendered and therefore has no frame to bind against.
export async function sidepanelOpen(
  rawRef:         string,
  sourceFileAddress: string,
  triggerRn:      RenderNode | null,
  attrs:          NodeAttrs,
): Promise<void> {
  // Already showing this trigger — nothing to do.
  if (triggerRn && _currentTriggerRn === triggerRn) return;

  // Same sidepanel target, different node under the same scope — keep the iframe
  // in place and only rewire the state relay to that node's frame.
  //
  // Keyed on the ref resolved against its own source file, not on what the
  // author typed: one viewer reached from two directories is "./viewer.html"
  // from the index and "../viewer.html" from a subdirectory, and comparing the
  // raw spellings rebuilds the iframe on every crossing — reloading the guest
  // and flashing its idle state between two nodes that share a panel.
  if (triggerRn && _currentRefKey === refKeyFor(rawRef, sourceFileAddress) && _panel) {
    const iframe = _panel.querySelector<HTMLIFrameElement>('.sidepanel-iframe');
    const win    = iframe?.contentWindow ?? null;
    const sidepanelPassRaw = attrs.get('sidepanel-pass') ?? null;
    const passEntries    = sidepanelPassRaw ? parsePass(sidepanelPassRaw) : [];
    const relay = sidepanelPassRaw
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
  const strategy = _sidepanelStrategies.get(name);
  if (!strategy) {
    _showError(`No sidepanel strategy for '${name}'.`);
    _currentTriggerRn = triggerRn;
    return;
  }

  let result: SidepanelResult | null;
  try {
    result = await strategy.build(rawRef, sourceFileAddress, attrs);
  } catch (err) {
    _showError(`Sidepanel failed to load: ${(err as Error).message}`);
    _currentTriggerRn = triggerRn;
    return;
  }
  if (!result) {
    _showError(`Sidepanel not found: ${rawRef}`);
    _currentTriggerRn = triggerRn;
    return;
  }

  const sidepanelPassRaw = attrs.get('sidepanel-pass') ?? null;
  const passEntries = sidepanelPassRaw ? parsePass(sidepanelPassRaw) : [];
  const relay = (sidepanelPassRaw && triggerRn)
    ? new StateRelay(buildStatePass(triggerRn.state, passEntries))
    : null;

  const iframe = _buildIframe(result, relay, passEntries);

  const onMessage = (e: MessageEvent) => {
    if (e.source !== iframe.contentWindow) return;
    if (e.data?.type === 'rvmark-escape') sidepanelClose();
  };
  window.addEventListener('message', onMessage);

  _currentTriggerRn  = triggerRn;
  _currentRefKey     = refKeyFor(rawRef, sourceFileAddress);
  _currentCleanup    = () => window.removeEventListener('message', onMessage);
}

// Explicitly close the panel (user action). Removes _panel from DOM entirely.
export function sidepanelClose(): void {
  if (!_panel) return;
  _currentCleanup?.();
  sidepanelSplitDetach();
  _panel.remove();
  _panel             = null;
  _currentTriggerRn  = null;
  _currentRefKey     = null;
  _currentCleanup    = null;
  document.body.classList.remove('sidepanel-open');
}

export function sidepanelIsOpen(): boolean {
  return _panel !== null;
}

export function sidepanelCurrentTrigger(): RenderNode | null {
  return _currentTriggerRn;
}

// The sidepanel in force for a node. Inherited down the source tree at parse time
// (inherited.ts), so this is a field read — no walk over rendered ancestors.
//
// A node's sidepanel is the one its own document declared over it. The DOM walk
// this replaced derived scope from where a subtree landed instead, so content
// transcluded into a page picked up that page's sidepanel rather than its own.
// Exported for tests: it reads only `rvNode`, so it is exercisable without
// a DOM. Callers in this module pass a real RenderNode.
export function sidepanelConfigOf(rn: { rvNode: RvNode }): SidepanelConfig | null {
  const scope = rn.rvNode.sidepanel;
  if (!scope) return null;
  return {
    rawRef:            scope.rawRef,
    // Inheritance never crosses a file, so this node's file is the one that
    // declared the scope — which is what the ref resolves against.
    sourceFileAddress: rn.rvNode.pageAddress,
    attrs:             scope.attrs,
  };
}

// Called by the renderer whenever selection changes.
// Loads the nearest enclosing sidepanel scope for the new selection.
// Blanks the panel if no sidepanel scope is found.
export function sidepanelNotifySelection(selectedRn: RenderNode): void {
  if (!_panel) return;
  const config = sidepanelConfigOf(selectedRn);
  if (!config) { _blankPanel(); return; }
  sidepanelOpen(config.rawRef, config.sourceFileAddress, selectedRn, config.attrs);
}

// ── Renderer interface ─────────────────────────────────────────────────────

// Open the sidepanel for the sidepanel in force at rn.
//
// An explicit open — {action: sidepanel}, or the keyboard equivalent — always
// opens the panel, even where no sidepanel is in force. The reader asked for the
// panel; showing it empty ("No sidepanel active") answers them, whereas doing
// nothing looks like a broken control. Only selection-driven updates
// (sidepanelNotifySelection) leave a closed panel closed.
export function sidepanelOpenFromNode(rn: RenderNode): void {
  const config = sidepanelConfigOf(rn);
  if (!config) { _ensurePanel(); _blankPanel(); return; }
  void sidepanelOpen(config.rawRef, config.sourceFileAddress, rn, config.attrs);
}

// ── Strategy: rvmark tree ─────────────────────────────────────────────────────

class RvmarkSidepanelStrategy extends SidepanelStrategy {
  async build(rawRef: string, sourceFileAddress: string): Promise<SidepanelResult | null> {
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
sidepanelRegister('rvmark', new RvmarkSidepanelStrategy());


// ── Strategy: html ────────────────────────────────────────────────────────────

class HtmlSidepanelStrategy extends SidepanelStrategy {
  async build(rawRef: string, sourceFileAddress: string): Promise<SidepanelResult | null> {
    const from = addressOf(sourceFileAddress);
    const fullPath = (await originFor(from.baseUrl).resolveResources(from.key, [rawRef]))[0] ?? rawRef;
    const displayName = fullPath.split('/').pop()!.replace(/\.html$/, '');

    // Always a URL, whatever origin it is on. An HTML sidepanel is a PAGE — its
    // scripts, styles and assets are named relative to where it lives, and the
    // only place they resolve is there. Fetching the markup and re-hosting it
    // in a srcdoc, which is what this did for a foreign origin, put the document
    // at an opaque origin where every one of those relative loads became a
    // cross-origin request its own server had no reason to permit: the page
    // arrived and then rendered as a shell of itself.
    //
    // Cross-origin is not the same as untrusted, and `src` is what says so
    // precisely. The document runs at ITS origin, with its own cookies, storage
    // and assets, and reaches nothing of ours — the same boundary an envoy runs
    // behind (origin-host.ts), for the same reason. What it cannot do is
    // anything to this page, and that was never what the srcdoc bought.
    return { title: displayName, url: addressToHref(fullPath) };
  }
}
sidepanelRegister('html', new HtmlSidepanelStrategy());
