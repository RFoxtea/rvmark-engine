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

import type { NodeTypeFactory, RenderNode } from '../render-node.js';
import { factoryRegister } from '../render-node.js';
import { resolveAttrs, treeNavKeydown, actionKeydown, copyPermalink, applyExhibit, expandNode } from '../handler-utils.js';
import { BaseTypeHandler } from '../base-handler.js';

import { wireSelectThenToggle } from '../interaction.js';
import { StateRelay, buildStatePass } from '../state.js';
import { postGuestMode, postPrerootSnapshot, wireRelay, registerThemeIframe, unregisterThemeIframe } from '../iframe-host.js';
import { parsePass } from '../handler-utils.js';

// ── Per-iframe relay setup ─────────────────────────────────────────────────────

function setupIframe(iframe: HTMLIFrameElement, content: HTMLElement): { activateRelay: () => void } {
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
      if (!isNaN(height)) iframe.style.height = height + 'px';
      if (parts[3] === 'init')
        (e.source as Window).postMessage(
          `[iFrameSizer]${parts[0]}:0:false:false:0:false:true:0:bodyOffset:none:0:0:false:parent:scroll`, '*',
        );
      return;
    }
    if (e.data?.type === 'rvmark-iframe-resize') iframe.style.height = e.data.height + 'px';
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
    const sourceNode = renderNode.sourceNode;
    const attrs = resolveAttrs(sourceNode);

    const rawUrl = attrs.get('src') ?? (sourceNode.label?.trim() || null);
    const url         = rawUrl ? sourceNode.sourceFile.resolveMediaUrl(rawUrl) : null;
    const srcdoc      = (!url && sourceNode.bodyLines?.length)
      ? sourceNode.bodyLines.join('\n') : null;
    const fixedHeight = attrs.get('height') ?? null;

    const content = this.content;
    content.classList.add('node-content--iframe');

    // ── Click / exhibit wiring ────────────────────────────────────────────────
    applyExhibit(renderNode, attrs);

    wireSelectThenToggle(content, () => {});

    const li = renderNode.li;

    if (url || srcdoc) {
      const iframe = document.createElement('iframe');
      iframe.className = 'html-body html-body-iframe';

      const isSameOrigin = url && (() => {
        try { return new URL(url, window.location.href).origin === window.location.origin; }
        catch { return false; }
      })();
      if (!isSameOrigin) iframe.setAttribute('sandbox', 'allow-scripts');
      if (fixedHeight) iframe.style.height = fixedHeight;

      const iframePassRaw = attrs.get('iframe-pass') ?? null;
      const iframePassEntries = iframePassRaw ? parsePass(iframePassRaw) : [];
      const relay = (iframePassRaw && isSameOrigin)
        ? new StateRelay(buildStatePass(renderNode.state, iframePassEntries))
        : null;

      const { activateRelay } = setupIframe(iframe, content);
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

    void expandNode(renderNode);
  }

}

const iframeFactory: NodeTypeFactory = {
  create(renderNode) {
    return new IframeTypeHandler(renderNode);
  },
  staticRenderBody(node) {
    const rawUrl = node.attrs.get('src') ?? (node.label?.trim() || null);
    if (rawUrl) {
      const url = node.sourceFile?.resolveMediaUrl(rawUrl) ?? rawUrl;
      const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      return `<a class="static-iframe-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(rawUrl)}</a>`;
    }
    if (!node.bodyLines?.length) return null;
    return `<div class="static-body html-body">${node.bodyLines.join('\n')}</div>`;
  },
};

factoryRegister('iframe', iframeFactory);
