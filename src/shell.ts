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
  const license = (p?.get('license') ?? '') as string;
  const author  = (nodeMeta?.author ?? p?.get('author') ?? '') as string;
  const footer  = document.querySelector('footer');
  if (!footer) return;

  if (!footerTextEl) {
    footer.innerHTML = '';
    footerTextEl = document.createElement('span');
    footer.appendChild(footerTextEl);
    footer.appendChild(document.createTextNode(' · '));
    const label = document.createElement('label');
    label.className = 'show-hidden-toggle footer-section';
    label.title = 'Show nodes marked [hidden]';
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


  let html = '<span class="footer-section">rvmark</span>';
  if (license) html += ` · <span class="footer-section">${mdInline(String(license))}</span>`;
  if (author)  html += ` · <span class="footer-section">${mdInline(String(author))}</span>`;
  footerTextEl.innerHTML = html;
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
