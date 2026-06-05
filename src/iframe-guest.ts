/**
 * iframe-guest.ts
 *
 * Runs inside an iframe (exhibit or otherwise). Loaded as a module script —
 * no inline scripts needed.
 *
 * Auto-registers on load (when window.parent !== window):
 *   - Escape key → parent.postMessage({ type: 'rvmark-escape' })
 *   - rvmark-select events → parent.postMessage({ type: 'exhibit-meta', meta })
 *   - error / unhandledrejection → parent.postMessage({ type: 'exhibit-error' })
 *
 * Also exports:
 *   - waitForPageContext(): used by main.ts in guest mode to get page context
 *     before initializing, replacing window.__RVMARK_PAGE__.
 *   - initPrerootListeners(preroot): wires rvmark-preroot-* messages to the
 *     preroot state API. Called by main.ts after it has set up the preroot frame.
 */

export interface RvmarkPageContext {
  file:   string;
  base:   string;
  anchor: string | null;
  focus:  string | null;
}

// ── Auto-registered listeners (always active in a guest) ──────────────────────

if (window.parent !== window) {
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !e.defaultPrevented) {
      e.preventDefault();
      parent.postMessage({ type: 'rvmark-escape' }, '*');
    }
  });

  document.addEventListener('rvmark-select', (e: Event) => {
    parent.postMessage({ type: 'exhibit-meta', meta: (e as CustomEvent).detail?.meta }, '*');
  });

  window.addEventListener('error', (e: ErrorEvent) => {
    parent.postMessage({ type: 'exhibit-error', message: e.message || String(e) }, '*');
  });

  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    parent.postMessage({ type: 'exhibit-error', message: String(e.reason?.message || e.reason || 'Unknown error') }, '*');
  });

  // Theme reception — applies vars sent by the host to :root.
  window.addEventListener('message', (e: MessageEvent) => {
    if (e.source !== parent) return;
    if (e.data?.type === 'rvmark-theme') {
      for (const [k, v] of Object.entries(e.data.vars as Record<string, string>))
        document.documentElement.style.setProperty(k, v);
    }
  });

  // Request theme on load so vars are set ASAP.
  parent.postMessage({ type: 'rvmark-request-theme' }, '*');
}

// ── Preroot state ─────────────────────────────────────────────────────────────

export function initPrerootListeners(preroot: {
  declare: (key: string, value: string) => void;
  set:     (key: string, value: string) => void;
  delete:  (key: string) => void;
  enableRelay?:   (fn: (op: 'declare' | 'set' | 'delete', key: string, value?: string) => void) => void;
  applyFromHost?: (key: string, value: string | undefined) => void;
}): void {
  const enableRelayFn = preroot.enableRelay ? () => {
    preroot.enableRelay!((op, key, value) => {
      parent.postMessage({ type: 'rvmark-state-write', op, key, value }, '*');
    });
  } : undefined;

  window.addEventListener('message', (e: MessageEvent) => {
    if (e.source !== parent) return;
    const d = e.data;
    if (!d?.type) return;
    if (d.type === 'rvmark-preroot-snapshot') {
      const frame = d.frame || {};
      for (const k in frame) preroot.declare(k, frame[k]);
    } else if (d.type === 'rvmark-relay-snapshot') {
      const frame = d.frame || {};
      for (const k in frame) (preroot.applyFromHost ?? preroot.declare)(k, frame[k]);
    } else if (d.type === 'rvmark-guest-mode') {
      document.documentElement.classList.add(d.cls as string);
      enableRelayFn?.();
      if (d.cls === 'rvmark-iframe-guest') _initIframeGuestMode();
    } else if (d.type === 'rvmark-keydown') {
      document.dispatchEvent(new KeyboardEvent('keydown', { ...d, bubbles: true, cancelable: true }));
    } else if (d.type === 'rvmark-keyup') {
      document.dispatchEvent(new KeyboardEvent('keyup',   { ...d, bubbles: true, cancelable: true }));
    } else if (d.type === 'rvmark-relay-tab-out') {
      const second = document.querySelector<HTMLElement>('[data-rvmark-second-tab-stop]');
      if (!second) return;
      const focused = document.activeElement;
      if (focused && focused !== document.body && focused !== second) {
        second.focus();
      } else {
        const onFocusin = (ev: FocusEvent) => {
          document.removeEventListener('focusin', onFocusin, true);
          if (ev.target !== second) second.focus();
        };
        document.addEventListener('focusin', onFocusin, true);
      }
    } else if (d.type === 'rvmark-preroot-declare') {
      preroot.declare(d.key, d.value);
    } else if (d.type === 'rvmark-preroot-set') {
      (preroot.applyFromHost ?? preroot.declare)(d.key, d.value);
    } else if (d.type === 'rvmark-preroot-delete') {
      preroot.applyFromHost ? preroot.applyFromHost(d.key, undefined) : preroot.delete(d.key);
    }
  });
}

function _initIframeGuestMode(): void {
  // Focus signalling
  window.addEventListener('focus', () => parent.postMessage({ type: 'rvmark-iframe-focused' }, '*'));
  window.addEventListener('blur',  () => parent.postMessage({ type: 'rvmark-iframe-blurred' }, '*'));

  // Second tab stop reporting
  function reportSecondTabStop() {
    parent.postMessage({ type: 'rvmark-has-second-tab-stop',
      value: !!document.querySelector('[data-rvmark-second-tab-stop]') }, '*');
  }
  reportSecondTabStop();
  new MutationObserver(reportSecondTabStop).observe(document.body, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ['data-rvmark-second-tab-stop'],
  });
}

// ── Page context ──────────────────────────────────────────────────────────────

export function waitForPageContext(): Promise<RvmarkPageContext> {
  return new Promise((resolve) => {
    window.addEventListener('message', function handler(e: MessageEvent) {
      if (e.source !== parent) return;
      if (e.data?.type === 'rvmark-page-context') {
        window.removeEventListener('message', handler);
        resolve(e.data.context as RvmarkPageContext);
      }
    });
  });
}
