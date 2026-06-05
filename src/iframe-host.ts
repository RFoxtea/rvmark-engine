/**
 * iframe-host.ts
 *
 * Host-side iframe protocol helpers shared by exhibit.ts and iframe.ts.
 *
 * Handles:
 *   - Posting page context to a guest iframe (rvmark-page-context)
 *   - Broadcasting preroot state to guest iframes (rvmark-preroot-*)
 *   - Sending a preroot snapshot on iframe load
 *   - Broadcasting theme CSS vars to registered iframes
 */

import { prerootFrame } from './state.js';
import type { StateRelay } from './state.js';
import type { PassEntry } from './state.js';

// ── Theme broadcasting ───────────────────────────────────────────────────────

const THEME_VARS = ['--bg','--fg','--muted','--accent','--accent-2','--accent-dim',
  '--border','--border-tree','--border-tag','--surface','--surface-2','--highlight','--dim','--warning'];

const activeThemeIframes = new Set<Window>();

// Probe element used to flatten system colors and color-mix() into concrete
// rgb() strings before sending to guests. getPropertyValue() on a custom
// property returns the literal text ("Canvas"), and guest iframes resolve
// system colors against their *own* color-scheme (default light), so the
// guest would paint light-mode regardless of host theme. Setting `color` on
// a real element forces the browser to resolve it host-side.
function resolveColor(value: string, probe: HTMLElement): string {
  probe.style.color = '';
  probe.style.color = value;
  return getComputedStyle(probe).color;
}

function sendTheme(win: Window): void {
  if (typeof document === 'undefined') return;
  const s = getComputedStyle(document.documentElement);
  const probe = document.createElement('span');
  probe.style.display = 'none';
  document.body.appendChild(probe);
  try {
    win.postMessage({
      type: 'rvmark-theme',
      vars: Object.fromEntries(
        THEME_VARS.map(v => [v, resolveColor(s.getPropertyValue(v).trim(), probe)]),
      ),
    }, '*');
  } finally {
    probe.remove();
  }
}

function broadcastTheme(): void {
  for (const win of activeThemeIframes) {
    if ((win as any).closed) activeThemeIframes.delete(win);
    else sendTheme(win);
  }
}

export function registerThemeIframe(win: Window): void {
  activeThemeIframes.add(win);
  sendTheme(win);
}

export function unregisterThemeIframe(win: Window): void {
  activeThemeIframes.delete(win);
}

if (typeof window !== 'undefined') {
  window.matchMedia?.('(prefers-color-scheme: dark)')?.addEventListener('change', broadcastTheme);
  if (typeof MutationObserver !== 'undefined') {
    new MutationObserver(broadcastTheme).observe(document.documentElement, {
      attributes: true, attributeFilter: ['style', 'class'],
    });
  }
  window.addEventListener('message', (e: MessageEvent) => {
    if (e.data?.type === 'rvmark-request-theme' && e.source && activeThemeIframes.has(e.source as Window)) {
      sendTheme(e.source as Window);
    }
  });
}

export interface RvmarkPageContext {
  file:   string;
  base:   string;
  anchor: string | null;
  focus:  string | null;
}

export function postPageContext(win: Window, ctx: RvmarkPageContext): void {
  win.postMessage({ type: 'rvmark-page-context', context: ctx }, '*');
}

export function postPrerootSnapshot(win: Window): void {
  win.postMessage({ type: 'rvmark-preroot-snapshot', frame: prerootFrame.flatten() }, '*');
}

export function postGuestMode(win: Window, cls: string): void {
  win.postMessage({ type: 'rvmark-guest-mode', cls }, '*');
}

export function broadcastPreroot(iframes: Iterable<HTMLIFrameElement>, msg: object): void {
  for (const iframe of iframes) {
    iframe.contentWindow?.postMessage(msg, '*');
  }
}

export function prerootDeclareMsg(key: string, value: string): object {
  return { type: 'rvmark-preroot-declare', key, value };
}

export function prerootSetMsg(key: string, value: string): object {
  return { type: 'rvmark-preroot-set', key, value };
}

export function prerootDeleteMsg(key: string): object {
  return { type: 'rvmark-preroot-delete', key };
}

// Wire a relay to an iframe window: send snapshot, listen for write-back, and
// subscribe to host-side changes to push them as rvmark-preroot-set/delete.
// Returns a cleanup function. Call again on iframe reload (it cleans up first).
export function wireRelay(relay: StateRelay, passEntries: PassEntry[], win: Window): () => void {
  win.postMessage({ type: 'rvmark-relay-snapshot', frame: relay.snapshot() }, '*');
  const writeBackCleanup = relay.listenWriteBack(win);
  const pushFns: Array<[string, (val: string | undefined) => void]> = [];
  for (const { childKey } of passEntries) {
    const fn = (val: string | undefined) => {
      if (val !== undefined) {
        win.postMessage({ type: 'rvmark-preroot-set', key: childKey, value: val }, '*');
      } else {
        win.postMessage({ type: 'rvmark-preroot-delete', key: childKey }, '*');
      }
    };
    relay.subscribe(childKey, fn);
    pushFns.push([childKey, fn]);
  }
  return () => {
    writeBackCleanup();
    for (const [key, fn] of pushFns) relay.unsubscribe(key, fn);
  };
}
