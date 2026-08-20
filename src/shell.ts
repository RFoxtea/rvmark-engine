/**
 * shell.ts
 *
 * DOM helpers for the page chrome: title, footer, tree root.
 * Owns all mutations to the fixed elements in template.html.
 */

import { mdInline } from './markdown.js';
import { keymapOpen } from './keymap.js';
import { prerootSet, prerootDelete } from './exhibit.js';
import { prerootFrame } from './state.js';
import { addressToHref, addressOrigin, RVMARK_SEGMENT } from './shared.js';
import type { Multimap } from './multimap.js';
import type { RenderNode } from './render-node.js';

let currentPageMeta: Multimap | null = null;
let footerTextEl: HTMLElement | null = null;
let viewMenuEl: HTMLDetailsElement | null = null;
let viewSourceLink: HTMLAnchorElement | null = null;
let viewStaticLink: HTMLAnchorElement | null = null;

export function setMeta(meta: Multimap | null): void {
  currentPageMeta = meta;
  const title = meta?.get('title') ?? meta?.get('slug') ?? 'rvmark';
  document.title = title;
  const siteTitle = document.getElementById('site-title');
  if (siteTitle) siteTitle.textContent = title;
  setFooter(null);
}

export function setFooter(nodeMeta: Record<string, unknown> | null): void {
  const p = currentPageMeta;
  const license = (nodeMeta?.license ?? p?.get('license') ?? '') as string;
  const author  = (nodeMeta?.author ?? p?.get('author') ?? '') as string;
  const footerLabel = (p?.get('footer-label') ?? 'rvmark') as string;
  const footer  = document.querySelector('footer');
  if (!footer) return;

  if (!footerTextEl) {
    footer.innerHTML = '';
    footerTextEl = document.createElement('span');
    footer.appendChild(footerTextEl);
    // The menu carries the show-hidden toggle, so it is also built when only
    // the toggle is wanted — `no-view-menu` suppresses the view links alone.
    const wantToggle = !p?.has('no-hidden-toggle');
    const wantViews  = !p?.has('no-view-menu');
    const wantKeymap = !p?.has('no-keymap');
    if (wantToggle || wantViews || wantKeymap) {
      if (footerLabel || license || author) footer.appendChild(document.createTextNode(' · '));
      viewMenuEl = buildViewMenu(wantViews, wantToggle, wantKeymap);
      footer.appendChild(viewMenuEl);
      if (wantViews) setViewTarget(null);
    }
  }


  // Any of these chips may be empty (footerLabel included), so join only the
  // present ones — never a leading, trailing, or doubled " · ".
  const chips: string[] = [];
  if (footerLabel) chips.push(`<span class="footer-section">${mdInline(footerLabel)}</span>`);
  if (license)     chips.push(`<span class="footer-section">${mdInline(String(license))}</span>`);
  if (author)      chips.push(`<span class="footer-section">${mdInline(String(author))}</span>`);
  footerTextEl.innerHTML = chips.join(' · ');
}

// Inserts search's own root element as a footer chip, right before the view
// menu (or at the end, if there is none) — called once by search.ts's own
// init, which always runs after the page's first setFooter call above, so by
// the time this runs footer already has its final [footerText] [· ]?
// [viewMenu]? shape (that lone separator, if present, sits directly before
// viewMenuEl). This slots search-root into that same gap rather than
// reasoning about the first separator at all: the existing " · " (if any)
// already correctly covers "is there footer text to separate from what comes
// next", so it's left exactly as is and simply ends up before search-root
// instead of before the view menu. All this adds is the *second* gap, between
// search-root and the view menu, which needs its own separator whenever a
// view menu exists — unlike the first gap, this one doesn't depend on
// per-node meta at all, since search-root itself is the "something before it"
// half of that gap, and search-root's presence never varies per node.
//
// search.ts builds and owns everything inside the element it hands us; this
// only decides *where* it lands, keeping shell.ts as the one place that
// mutates footer's own children, per the file header.
export function mountSearchRoot(el: HTMLElement): void {
  const footer = document.querySelector('footer');
  if (!footer) return;
  footer.insertBefore(el, viewMenuEl);
  if (viewMenuEl) footer.insertBefore(document.createTextNode(' · '), viewMenuEl);
}

// ── View menu ─────────────────────────────────────────────────────────────────
// A footer drop-up offering the two non-interactive views of whatever node is
// currently selected: the .rvmark source it came from, and the no-JS static
// rendering of its page. Both open in a new tab.
//
// Node identity travels by permalinkId, which is the same id the static
// renderer stamps onto its <li>s — so one fragment anchors correctly in the
// static view, and (for the source file) at least names the node being read.

function buildViewMenu(withViews: boolean, withToggle: boolean, withKeymap: boolean): HTMLDetailsElement {
  const details = document.createElement('details');
  details.className = 'view-menu footer-section';

  const summary = document.createElement('summary');
  summary.setAttribute('aria-label', 'Views and options');
  details.appendChild(summary);

  const menu = document.createElement('div');
  menu.className = 'view-menu-items';

  if (withViews) {
    viewSourceLink = document.createElement('a');
    viewSourceLink.textContent = 'rvmark source';
    viewSourceLink.target = '_blank';
    viewSourceLink.rel = 'noopener';

    viewStaticLink = document.createElement('a');
    viewStaticLink.textContent = 'static view';
    viewStaticLink.target = '_blank';
    viewStaticLink.rel = 'noopener';

    menu.append(viewSourceLink, viewStaticLink);
  }

  // The keymap row. A <button>, not a link: it opens a panel in place rather
  // than going anywhere, so it must not offer a target to middle-click or copy.
  // Sits with the view links — both are "show me something about this page" —
  // and above the separator that fences off the show-hidden toggle.
  if (withKeymap) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'keymap-row';
    // Visible text is the accessible name — no aria-label, matching the view
    // links above and leaving one source of truth for what the row says.
    btn.textContent = 'Keyboard controls';
    btn.addEventListener('click', () => {
      details.open = false;
      keymapOpen();
    });
    menu.appendChild(btn);
  }

  if (withToggle) {
    if (withViews || withKeymap) {
      const sep = document.createElement('hr');
      sep.className = 'view-menu-sep';
      menu.appendChild(sep);
    }
    const label = document.createElement('label');
    label.className = 'show-hidden-toggle';
    // The label is the focusable row; the checkbox it wraps stays out of the
    // tab order so the row is a single stop. Clicking the label still toggles
    // the checkbox natively, and the keydown handler forwards Enter/Space.
    label.tabIndex = 0;
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = 'show-hidden-cb';
    cb.tabIndex = -1;
    if (prerootFrame.get('--show-hidden')) cb.checked = true;
    cb.addEventListener('change', function (this: HTMLInputElement) {
      if (this.checked) prerootSet('--show-hidden', 'true');
      else prerootDelete('--show-hidden');
    });
    label.appendChild(cb);
    // The marker is real text ('[', tick, ']') rather than a ::before whose
    // content swaps: only the tick cell changes, and it holds a fixed width,
    // so ticking the box cannot reflow the label beside it.
    const marker = document.createElement('span');
    marker.className = 'checkmark';
    marker.setAttribute('aria-hidden', 'true');
    marker.append('[', Object.assign(document.createElement('span'), { className: 'tick' }), ']');
    label.appendChild(marker);
    label.appendChild(document.createTextNode(' show hidden'));
    menu.appendChild(label);
  }

  details.appendChild(menu);

  // Close on outside click or Escape, the way a menu is expected to behave.
  document.addEventListener('click', (e) => {
    if (details.open && !details.contains(e.target as Node)) details.open = false;
  });

  // ── Keyboard navigation ────────────────────────────────────────────────────
  // Stays a native <details> disclosure: <summary> keeps its built-in
  // Enter/Space, the links stay links, and the toggle keeps its real checkbox.
  // Arrow keys are layered on top so it drives like a dropdown.
  //
  // The rows are <a>s and a <button>, plus a <label>. A label is not focusable
  // on its own, so it carries tabindex="0" and forwards activation to the
  // checkbox it wraps — that way every row is one Tab stop and one arrow target.

  // Live, in DOM order: the panel is rebuilt in only one place, but rows are
  // conditional, so never assume which ones exist.
  const rows = (): HTMLElement[] =>
    Array.from(menu.querySelectorAll<HTMLElement>('a, .keymap-row, .show-hidden-toggle'));

  const focusRow = (i: number): void => {
    const list = rows();
    if (!list.length) return;
    // Wrap around, so Down past the end returns to the top.
    list[(i + list.length) % list.length].focus();
  };

  const open = (focusIdx: number | null): void => {
    details.open = true;
    if (focusIdx !== null) focusRow(focusIdx);
  };

  const close = (refocus: boolean): void => {
    details.open = false;
    if (refocus) summary.focus();
  };

  summary.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      // Down enters at the top of the list, Up at the bottom.
      open(e.key === 'ArrowDown' ? 0 : -1);
    }
  });

  menu.addEventListener('keydown', (e: KeyboardEvent) => {
    const list = rows();
    const idx  = list.indexOf(document.activeElement as HTMLElement);

    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); focusRow(idx + 1); break;
      case 'ArrowUp':   e.preventDefault(); focusRow(idx - 1); break;
      case 'Home':      e.preventDefault(); focusRow(0);       break;
      case 'End':       e.preventDefault(); focusRow(-1);      break;
      case 'Tab':
        // Tabbing out of the panel means the user is done with it.
        close(false);
        break;
      case ' ':
      case 'Enter': {
        // A focused label has no default action of its own — forward to the
        // checkbox. Links and the keymap button keep their native activation.
        const row = list[idx];
        if (row?.classList.contains('show-hidden-toggle')) {
          e.preventDefault();
          row.querySelector<HTMLInputElement>('input')?.click();
        }
        break;
      }
    }
  });

  details.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape' && details.open) {
      e.stopPropagation();   // don't let the tree also act on this Escape
      close(true);
    }
  });

  // Closing by any route (Escape, outside click, toggling the summary) must not
  // strand focus on a row that is now hidden.
  details.addEventListener('toggle', () => {
    if (!details.open && menu.contains(document.activeElement)) summary.focus();
  });

  return details;
}

// Point the menu's two links at `rn` (or, when null, at the current page with no
// fragment). Called on every selection change.
export function setViewTarget(rn: RenderNode | null): void {
  if (!viewSourceLink || !viewStaticLink) return;

  // pageAddress is canonical ('/_rvmark/docs/writing.rvmark'), which is already
  // the URL the source file is served from — no mapping needed beyond origin.
  const pageAddress = rn?.sourceNode?.served?.pageAddress
    ?? (window.__RVMARK_PAGE__ ? RVMARK_SEGMENT + window.__RVMARK_PAGE__.file : '');
  const fragment = rn?.permalinkId ? '#' + rn.permalinkId : '';

  // Hide the links, not the menu — it also holds the show-hidden toggle, which
  // stays meaningful with no resolvable page address.
  if (!pageAddress) {
    viewSourceLink.style.display = 'none';
    viewStaticLink.style.display = 'none';
    return;
  }
  viewSourceLink.style.removeProperty('display');
  viewStaticLink.style.removeProperty('display');

  viewSourceLink.href = pageAddress;

  // addressToHref maps '/_rvmark/foo.rvmark' → '/foo' (no trailing slash). The
  // query has to go after a slash: '/foo?--static' would make the page's
  // relative asset paths resolve against '/' rather than '/foo/'. `--static` is
  // read by main.ts, which reveals #static-content and leaves the tree unbuilt.
  const origin   = addressOrigin(pageAddress);
  const pageHref = addressToHref(pageAddress.slice(origin.length));
  const dirHref  = pageHref.endsWith('/') ? pageHref : pageHref + '/';
  viewStaticLink.href = origin + dirHref + '?--static' + fragment;
}

export function clearTree(): HTMLElement {
const root = document.getElementById('tree-root')!;
  root.innerHTML = '';
  return root;
}

export function showError(msg: string): void {
  const root = clearTree();
  const li = document.createElement('li');
  li.style.cssText = 'padding:1rem;color:var(--muted);font-size:0.85rem;';
  li.textContent = msg;
  root.appendChild(li);
}
