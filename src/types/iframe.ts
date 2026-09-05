/**
 * types/iframe.new.ts
 *
 * Renders an HTML fragment in the node body inside a sandboxed iframe.
 * Two modes:
 *   - Inline block: body lines collected by the parser from a fenced code block
 *       - {= iframe}
 *       ```
 *       <p>raw HTML here</p>
 *       ```
 *   - URL fetch: HTML fetched from a remote URL via iframe.src
 *       {= iframe} ./path/to/fragment.html
 *
 * Optional: width / height: CSS length; ratio: w/h (e.g. 4/3, 16:9).
 *   height wins over ratio, as in CSS. Setting either stops the guest's
 *   self-reported height from resizing the frame.
 *
 * staticRenderBody: inline block only (URL fetch not available at build time).
 *
 * Focus model: sandboxed iframes cannot receive programmatic focus. Enter/Space
 * on the node row activates "relay mode" — keystrokes are forwarded to the iframe
 * via postMessage. Escape exits relay mode.
 *
 * postMessage API (child pages implement this with the rvmark iframe API block):
 *   parent → child: { type: 'rvmark-theme', vars: { '--bg': '…', … } }
 *   parent → child: { type: 'rvmark-keydown', key, code, shiftKey, … }
 *   parent → child: { type: 'rvmark-keyup', key, code, … }
 *   parent → child: { type: 'rvmark-focus' }
 *   parent → child: { type: 'rvmark-blur' }
 *   parent → child: { type: 'rvmark-relay-activated' }
 *   child → parent: { type: 'rvmark-iframe-resize', height: number }
 *   child → parent: { type: 'rvmark-request-theme' }
 *   child → parent: { type: 'rvmark-escape' }
 *   child → parent: { type: 'rvmark-iframe-focused' }
 *   child → parent: { type: 'rvmark-iframe-blurred' }
 *   parent → child: { type: 'rvmark-relay-tab-out' }
 *   child → parent: { type: 'rvmark-has-second-tab-stop', value: boolean }
 */

import './iframe.declare.js';
import type { NodeTypeFactory, RenderNode } from '../client/render-node.js';
import { factoryRegister } from '../client/render-node.js';
import { treeNavKeydown, actionKeydown, copyPermalink } from '../client/handler-utils.js';
import { ToggleSet } from '../client/toggle-set.js';
import { BaseTypeHandler } from '../client/base-handler.js';
import { resolveMediaOn } from '../client/origin-host.js';

import { wireSelectThenAction } from '../client/interaction.js';
import { StateRelay, buildStatePass } from '../client/state.js';
import { postGuestMode, postPrerootSnapshot, wireRelay, registerThemeIframe, unregisterThemeIframe } from '../client/iframe-host.js';
import { parsePass, resolveBox, applyBox } from '../client/handler-utils.js';

// ── Per-iframe relay setup ─────────────────────────────────────────────────────

/**
 * A guest-reported height is data from the framed page, which for a remote URL
 * is not the author's. Bound it so a hostile or broken guest cannot claim a
 * megapixel-tall box and push the rest of the document off screen.
 */
function isSaneHeight(h: unknown): h is number {
  return typeof h === 'number' && Number.isFinite(h) && h > 0 && h <= 20000;
}

// `authorSized` suppresses the guest's self-reported height: an explicit height
// or ratio is the author overriding the content, so auto-resize must not undo it.
function setupIframe(iframe: HTMLIFrameElement, content: HTMLElement, authorSized = false): { activateRelay: () => void } {
  let relayActive = false;
  let hasSecondTabStop = false;

  const relay = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { deactivateRelay(); return; }
    if (e.key === 'Tab') {
      if (hasSecondTabStop && !e.shiftKey) iframe.contentWindow?.postMessage({ type: 'rvmark-relay-tab-out' }, '*');
      deactivateRelay(false);
      if (!hasSecondTabStop) {
        iframe.tabIndex = -1;
        const restoreTabIndex = () => {
          iframe.tabIndex = 0;
          document.removeEventListener('focusin', restoreTabIndex, true);
          window.removeEventListener('blur', restoreTabIndex);
          clearTimeout(timer);
        };
        document.addEventListener('focusin', restoreTabIndex, true);
        window.addEventListener('blur', restoreTabIndex);
        const timer = setTimeout(restoreTabIndex, 100);
      }
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    iframe.contentWindow?.postMessage({
      type: 'rvmark-keydown', key: e.key, code: e.code,
      shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey, repeat: e.repeat,
    }, '*');
  };

  const relayKeyup = (e: KeyboardEvent) => {
    iframe.contentWindow?.postMessage({
      type: 'rvmark-keyup', key: e.key, code: e.code,
      shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey,
    }, '*');
  };

  const onSelect = (e: Event) => { if ((e as CustomEvent).target !== content) deactivateRelay(); };
  const onClick  = () => deactivateRelay();

  function activateRelay(): void {
    if (relayActive) return;
    relayActive = true;
    if (!hasSecondTabStop) iframe.tabIndex = -1;
    content.classList.add('node-content--iframe-active');
    document.addEventListener('keydown', relay, true);
    document.addEventListener('keyup', relayKeyup, true);
    document.addEventListener('rvmark-select', onSelect, true);
    document.addEventListener('click', onClick, true);
    iframe.contentWindow?.postMessage({ type: 'rvmark-focus' }, '*');
    iframe.contentWindow?.postMessage({ type: 'rvmark-relay-activated' }, '*');
  }

  function deactivateRelay(restoreTabIndex = true): void {
    if (!relayActive) return;
    relayActive = false;
    if (restoreTabIndex) iframe.tabIndex = 0;
    content.classList.remove('node-content--iframe-active');
    document.removeEventListener('keydown', relay, true);
    document.removeEventListener('keyup', relayKeyup, true);
    document.removeEventListener('rvmark-select', onSelect, true);
    document.removeEventListener('click', onClick, true);
    iframe.contentWindow?.postMessage({ type: 'rvmark-blur' }, '*');
  }

  const messageHandler = (e: MessageEvent) => {
    if (e.source !== iframe.contentWindow) return;
    if (typeof e.data === 'string' && e.data.startsWith('[iFrameSizer]')) {
      const parts = e.data.slice(13).split(':');
      const height = parseInt(parts[1], 10);
      if (!authorSized && isSaneHeight(height)) iframe.style.height = height + 'px';
      if (parts[3] === 'init')
        (e.source as Window).postMessage(
          `[iFrameSizer]${parts[0]}:0:false:false:0:false:true:0:bodyOffset:none:0:0:false:parent:scroll`, '*',
        );
      return;
    }
    if (e.data?.type === 'rvmark-iframe-resize' && !authorSized && isSaneHeight(e.data.height))
      iframe.style.height = e.data.height + 'px';
    if (e.data?.type === 'rvmark-iframe-focused') {
      content.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      content.classList.add('node-content--iframe-focused');
    }
    if (e.data?.type === 'rvmark-iframe-blurred') content.classList.remove('node-content--iframe-focused');
    if (e.data?.type === 'rvmark-escape') {
      const wasRelay = relayActive;
      deactivateRelay();
      content.focus();
      if (!wasRelay) iframe.contentWindow?.postMessage({ type: 'rvmark-blur' }, '*');
    }
    if (e.data?.type === 'rvmark-has-second-tab-stop') {
      hasSecondTabStop = e.data.value;
      if (relayActive) iframe.tabIndex = hasSecondTabStop ? 0 : -1;
    }
  };
  window.addEventListener('message', messageHandler);

  iframe.addEventListener('load', () => {
    if (iframe.contentWindow) {
      registerThemeIframe(iframe.contentWindow);
      postGuestMode(iframe.contentWindow, 'rvmark-iframe-guest');
      postPrerootSnapshot(iframe.contentWindow);
    }
    new MutationObserver((_, obs) => {
      if (!iframe.isConnected) {
        if (iframe.contentWindow) unregisterThemeIframe(iframe.contentWindow);
        window.removeEventListener('message', messageHandler);
        obs.disconnect();
        deactivateRelay();
        content.classList.remove('node-content--iframe-focused');
      }
    }).observe(document.body, { childList: true, subtree: true });
  });

  return { activateRelay };
}

// ── Type handler ───────────────────────────────────────────────────────────────

class IframeTypeHandler extends BaseTypeHandler {
  private _activateRelay: (() => void) | null = null;

  constructor(renderNode: RenderNode) {
    super(renderNode, '*');
    const rvNode = renderNode.rvNode;
    const attrs = rvNode.attrs;

    const rawUrl = attrs.get('src') ?? (rvNode.label?.trim() || null);
    const box = resolveBox(attrs, 'iframe');

    const content = this.content;
    content.classList.add('node-content--iframe');

    // ── Click / sidepanel wiring ────────────────────────────────────────────────

    // No re-click action: the iframe owns its own interior clicks.
    wireSelectThenAction(content, () => {}, content, undefined, () => false);

    const li = renderNode.li;

    // The whole frame waits on the URL: `srcdoc` is the fallback for a node with
    // no resolvable src, so which of the two is used cannot be decided until the
    // origin has answered.
    void (async () => {
      const url    = await resolveMediaOn(rvNode, rawUrl);
      const srcdoc = (!url && rvNode.bodyLines?.length)
        ? rvNode.bodyLines.join('\n') : null;

      if (url || srcdoc) {
        const iframe = document.createElement('iframe');
        iframe.className = 'html-body html-body-iframe';

        const isSameOrigin = url && (() => {
          try { return new URL(url, window.location.href).origin === window.location.origin; }
          catch { return false; }
        })();
        if (!isSameOrigin) iframe.setAttribute('sandbox', 'allow-scripts');
        applyBox(iframe, box);

        const iframePassRaw = attrs.get('iframe-pass') ?? null;
        const iframePassEntries = iframePassRaw ? parsePass(iframePassRaw) : [];
        const relay = (iframePassRaw && isSameOrigin)
          ? new StateRelay(buildStatePass(renderNode.state, iframePassEntries))
          : null;

        const { activateRelay } = setupIframe(iframe, content, !!(box.height || box.ratio));
        this._activateRelay = activateRelay;

        if (relay) {
          let relayCleanup: (() => void) | null = null;
          iframe.addEventListener('load', () => {
            if (iframe.contentWindow) {
              relayCleanup?.();
              relayCleanup = wireRelay(relay, iframePassEntries, iframe.contentWindow);
            }
          });
          new MutationObserver((_, obs) => {
            if (!iframe.isConnected) { relayCleanup?.(); obs.disconnect(); }
          }).observe(document.body, { childList: true, subtree: true });
        }

        if (url) {
          iframe.src = url;
        } else {
          iframe.srcdoc = srcdoc!;
        }

        content.appendChild(iframe);
      }
    })();

    content.addEventListener('keydown', (e) => {
      if (e.target !== content) return;
      if (actionKeydown(e, renderNode)) return;
      switch (e.key) {
        case 'Enter':
        case ' ':
          this._activateRelay?.();
          e.preventDefault();
          return;
        case 'c':
          if (!e.ctrlKey && !e.metaKey) {
            copyPermalink(renderNode);
            e.preventDefault();
          }
          return;
      }
      treeNavKeydown(e, content, li);
    });

    new ToggleSet(renderNode, attrs, { alwaysOpen: true }).mountOnce();
  }

}

const iframeFactory: NodeTypeFactory = {
  create(renderNode) {
    return new IframeTypeHandler(renderNode);
  },
  staticRenderBody(node, ctx) {
    const rawUrl = node.attrs.get('src') ?? (node.label?.trim() || null);
    if (rawUrl) {
      const url = ctx.resolveMedia(node, rawUrl);
      const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      return `<a class="static-iframe-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(rawUrl)}</a>`;
    }
    if (!node.bodyLines?.length) return null;
    return `<div class="block-body html-body">${node.bodyLines.join('\n')}</div>`;
  },
};

factoryRegister('iframe', iframeFactory);
