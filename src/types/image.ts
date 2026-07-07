/**
 * types/image.new.ts
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
import { resolveAttrs, copyPermalink, treeNavKeydown, actionKeydown, expandNode } from '../handler-utils.js';
import { BaseTypeHandler } from '../base-handler.js';

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
  constructor(renderNode: RenderNode) {
    super(renderNode, 'a[href]');
    const sourceNode = renderNode.sourceNode;
    const attrs = resolveAttrs(sourceNode);
    const rawUrl = attrs.get('src') ?? sourceNode.label ?? null;
    let url: string | null = null;
    if (rawUrl) {
      const resolved = sourceNode.sourceFile.resolveMediaUrl(rawUrl);
      const proto = (resolved.match(/^([a-zA-Z][a-zA-Z0-9+\-.]*):/) ?? [])[1]?.toLowerCase();
      url = (!proto || ['http', 'https'].includes(proto)) ? resolved : null;
    }
    const alt        = attrs.get('alt') ?? '';
    const darkClass  = DARK_MODE_CLASSES[attrs.get('dark-mode') ?? ''] ?? '';
    const alignClass = ALIGN_CLASSES[attrs.get('align') ?? ''] ?? '';
    const widthRaw   = attrs.get('width');
    const width      = widthRaw && WIDTH_RE.test(widthRaw.trim()) ? widthRaw.trim() : '';

    const content = this.content;
    const li = renderNode.li;

    if (url) {
      const figure = document.createElement('figure');
      figure.className = ['img-body', darkClass, alignClass].filter(Boolean).join(' ');

      const img = document.createElement('img');
      img.src     = url;
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
    }

    content.addEventListener('keydown', (e) => {
      if (e.target !== content) return;
      if (actionKeydown(e, renderNode)) return;
      if (e.key === 'c' && !e.ctrlKey && !e.metaKey) {
        copyPermalink(renderNode);
        e.preventDefault();
        return;
      }
      treeNavKeydown(e, content, li);
    });

    void expandNode(renderNode);
  }
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const imageFactory: NodeTypeFactory = {
  create(renderNode) {
    return new ImageTypeHandler(renderNode);
  },
  staticRenderBody(node) {
    const rawUrl = node.attrs.get('src') ?? node.label ?? null;
    const url = rawUrl ? node.sourceFile.resolveMediaUrl(rawUrl) : null;
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
