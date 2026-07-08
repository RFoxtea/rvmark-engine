/**
 * shell.ts
 *
 * DOM helpers for the page chrome: title, footer, tree root.
 * Owns all mutations to the fixed elements in template.html.
 */

import { mdInline } from './markdown.js';
import { prerootSet, prerootDelete } from './exhibit.js';
import { prerootFrame } from './state.js';
import type { Multimap } from './multimap.js';

let currentPageMeta: Multimap | null = null;
let footerTextEl: HTMLElement | null = null;

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
    if (!p?.has('no-hidden-toggle')) {
      if (footerLabel || license || author) footer.appendChild(document.createTextNode(' · '));
      const label = document.createElement('label');
      label.className = 'show-hidden-toggle footer-section';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.id = 'show-hidden-cb';
      if (prerootFrame.get('--show-hidden')) cb.checked = true;
      cb.addEventListener('change', function (this: HTMLInputElement) {
        if (this.checked) prerootSet('--show-hidden', 'true');
        else prerootDelete('--show-hidden');
      });
      label.appendChild(cb);
      label.appendChild(document.createTextNode(' show hidden'));
      footer.appendChild(label);
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
