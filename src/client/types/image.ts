/**
 * types/image.ts
 *
 * Renders an image in the node body.
 * Syntax: {= image} https://example.com/photo.jpg
 *      or {type: image; src: https://example.com/photo.jpg}
 * Optional: alt: some description
 * Optional: dark-mode: invert | background | none
 * Optional: align: left | center | right
 * Optional: width: CSS length (e.g. 50%, 300px) — constrains the image width
 */

import type { NodeTypeFactory, RenderNode } from '../render-node.js';
import { factoryRegister } from '../render-node.js';
import { copyPermalink, treeNavKeydown, actionKeydown } from '../handler-utils.js';
import { ToggleSet } from '../toggle-set.js';
import { BaseTypeHandler } from '../base-handler.js';
import { resolveMediaOn } from '../../envoy/origin.js';

const DARK_MODE_CLASSES: Record<string, string> = {
  invert:     'img-body--dark-invert',
  background: 'img-body--dark-background',
};

const ALIGN_CLASSES: Record<string, string> = {
  left:   'img-body--left',
  center: 'img-body--center',
  right:  'img-body--right',
};

const WIDTH_RE = /^[0-9]+(\.[0-9]+)?(px|em|rem|%|vw|vh|ch|ex|cm|mm|in|pt|pc)$/;

class ImageTypeHandler extends BaseTypeHandler {
  // Filled once the origin answers. The keydown handler below closes over the
  // handler rather than a local, so a copy issued before the URL lands is a
  // no-op rather than a copy of the wrong thing.
  private url: string | null = null;

  constructor(renderNode: RenderNode) {
    super(renderNode, 'a[href]');
    const sourceNode = renderNode.sourceNode;
    const attrs = sourceNode.attrs;
    const rawUrl = attrs.get('src') ?? sourceNode.label ?? null;
    const alt        = attrs.get('alt') ?? '';
    const darkClass  = DARK_MODE_CLASSES[attrs.get('dark-mode') ?? ''] ?? '';
    const alignClass = ALIGN_CLASSES[attrs.get('align') ?? ''] ?? '';
    const widthRaw   = attrs.get('width');
    const width      = widthRaw && WIDTH_RE.test(widthRaw.trim()) ? widthRaw.trim() : '';

    const content = this.content;
    const li = renderNode.li;

    void (async () => {
      const resolved = await resolveMediaOn(sourceNode, rawUrl);
      if (!resolved) return;
      const proto = (resolved.match(/^([a-zA-Z][a-zA-Z0-9+\-.]*):/) ?? [])[1]?.toLowerCase();
      if (proto && !['http', 'https'].includes(proto)) return;
      this.url = resolved;

      const figure = document.createElement('figure');
      figure.className = ['img-body', darkClass, alignClass].filter(Boolean).join(' ');

      const img = document.createElement('img');
      img.src     = resolved;
      img.alt     = alt;
      img.loading = 'lazy';
      if (width) img.style.width = width;
      figure.appendChild(img);

      if (alt) {
        const cap = document.createElement('figcaption');
        cap.textContent = alt;
        figure.appendChild(cap);
      }

      content.appendChild(figure);
    })();

    content.addEventListener('keydown', (e) => {
      if (e.target !== content) return;
      if (actionKeydown(e, renderNode)) return;
      if (e.key === 'c') {
        if (e.ctrlKey || e.metaKey) {
          // Defer to the browser whenever there is a selection to copy.
          if (this.url && !window.getSelection()?.toString()) {
            copyImage(this.url, alt);
            e.preventDefault();
          }
        } else {
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

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// image/png is the only bitmap type the Clipboard API requires implementations
// to support, so anything else is re-encoded through a canvas. That needs the
// image to be CORS-readable, and it rasterises — an animated GIF becomes one
// frame — so the html and plain flavours are always written alongside it as
// the lossless fallbacks a receiving app can prefer.
async function pngBlob(url: string): Promise<Blob> {
  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  if (blob.type === 'image/png') return blob;

  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width  = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
  bitmap.close();
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(b => b ? resolve(b) : reject(new Error('encode failed')), 'image/png');
  });
}

function copyImage(url: string, alt: string): void {
  const absolute = new URL(url, window.location.href).href;
  const html = `<img src="${esc(absolute)}" alt="${esc(alt)}">`;
  const item = {
    // Safari rejects a write whose ClipboardItem was built from an awaited
    // value — the gesture is considered spent — so the png is handed over as a
    // pending promise instead.
    'image/png':  pngBlob(absolute),
    'text/html':  new Blob([html],     { type: 'text/html' }),
    'text/plain': new Blob([absolute], { type: 'text/plain' }),
  };
  navigator.clipboard.write([new ClipboardItem(item)])
    // A tainted canvas, a CORS-less host or an unsupported source format all
    // land here; the URL is still worth having.
    .catch(() => navigator.clipboard.writeText(absolute).catch(() => {}));
}

const imageFactory: NodeTypeFactory = {
  create(renderNode) {
    return new ImageTypeHandler(renderNode);
  },
  staticRenderBody(node, ctx) {
    const rawUrl = node.attrs.get('src') ?? node.label ?? null;
    const url = rawUrl ? ctx.resolveMedia(node, rawUrl) : null;
    if (!url) return null;
    const alt        = node.attrs.get('alt') ?? '';
    const darkClass  = DARK_MODE_CLASSES[node.attrs.get('dark-mode') ?? ''] ?? '';
    const alignClass = ALIGN_CLASSES[node.attrs.get('align') ?? ''] ?? '';
    const cls        = ['img-body', darkClass, alignClass].filter(Boolean).join(' ');
    const widthRaw   = node.attrs.get('width');
    const width      = widthRaw && WIDTH_RE.test(widthRaw.trim()) ? widthRaw.trim() : '';
    const widthAttr  = width ? ` style="width:${esc(width)}"` : '';
    const cap        = alt ? `<figcaption>${esc(alt)}</figcaption>` : '';
    return `<figure class="${esc(cls)}"><img src="${esc(url)}" alt="${esc(alt)}" loading="lazy"${widthAttr}>${cap}</figure>`;
  },
};

factoryRegister('image', imageFactory);
