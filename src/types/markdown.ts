/**
 * types/markdown.ts
 *
 * Implements the `block` node type: a multiline Markdown body rendered inside a
 * node. Body lines are collected by the parser from a following fenced code
 * block. Supports:
 *   - Inline block: body lines inside a fenced code block (``` or ~~~)
 *   - File mode: {= block} ./path/to/file.md  or  ./file.md#Section
 *
 * Uses full CommonMark + GFM via marked.js, KaTeX math at runtime.
 *
 * Syntax:
 *   1. {= block}
 *      ~~~
 *      **bold** text here
 *      ~~~
 *   or
 *   1. {= block} ./docs/page.md#Introduction
 */

import type { NodeTypeFactory, SourceNode, RenderNode } from '../render-node.js';
import { factoryRegister } from '../render-node.js';
import { treeNavKeydown, actionKeydown, listboxKeydown, copyPermalink, applyOnSpawn, applyEventAttr, applyOnAction, expandNode, exhibitOpenFromNode, wireBulletActions } from '../handler-utils.js';
import { resolveAttrs } from '../source-file.js';
import { BaseTypeHandler } from '../base-handler.js';
import { wireListbox, isListbox } from '../listbox-utils.js';
import type { ListboxNav } from '../listbox.js';
import { wireSelectThenAction } from '../interaction.js';
import { mdToHtmlWithSpans, staticMdToHtml, ensureKatex, hasMath, katexLoaded } from '../markdown.js';
import type { ParsedSpanAttrs } from '../markdown.js';

// ── Overflow fade ──────────────────────────────────────────────────────────────

function initOverflowFade(outer: HTMLElement, scroller: HTMLElement): void {
  const update = () => {
    const overflows = scroller.scrollHeight > scroller.clientHeight + 1;
    outer.toggleAttribute('data-overflow', overflows);
    outer.toggleAttribute('data-scrolled-to-top', scroller.scrollTop <= 2);
    outer.toggleAttribute('data-scrolled-to-bottom',
      scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2);
  };
  scroller.addEventListener('scroll', update, { passive: true });
  new ResizeObserver(update).observe(scroller);
}

// ── Section extraction ─────────────────────────────────────────────────────────

function mdHeadingSlug(text: string): string {
  return text.toLowerCase().replace(/\s+/g, '-').replace(/[^\w-]/g, '').replace(/^-+|-+$/g, '');
}

function extractMdSection(text: string, sectionSlug: string): string {
  const levelM = sectionSlug.match(/^(#+)(.*)/);
  if (!levelM) throw new Error(`invalid section slug: ${sectionSlug}`);
  const targetLevel = levelM[1].length;
  const slug        = levelM[2];
  const lines = text.split('\n');
  let start = -1;
  let end = lines.length;
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimStart().startsWith('```')) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = lines[i].match(/^(#+)\s+(.*)/);
    if (!m) continue;
    const level = m[1].length;
    if (start === -1) {
      if (level === targetLevel && mdHeadingSlug(m[2].trim()) === slug) start = i;
    } else {
      if (level <= targetLevel) { end = i; break; }
    }
  }
  if (start === -1) throw new Error(`section not found: ${sectionSlug}`);
  return lines.slice(start + 1, end).join('\n');
}

// ── Type handler ───────────────────────────────────────────────────────────────

class MarkdownTypeHandler extends BaseTypeHandler {
  readonly managesReady = true as const;
  private _listboxNav?: ListboxNav;
  private _actionVal:  string | null = null;
  private _src:        string | null = null;

  constructor(rn: RenderNode) {
    super(rn, 'a[href], pre, .md-body-scroll, .md-math-block, .katex-display, .katex-html');
    const sourceNode = rn.sourceNode;
    const attrs = resolveAttrs(sourceNode);
    applyOnSpawn(attrs, rn);

    const { content } = this;

    this._actionVal = attrs.get('action') ?? null;
    if (this._actionVal === 'exhibit') {
      wireSelectThenAction(content, () => { exhibitOpenFromNode(rn); applyOnAction(rn); });
    } else {
      wireSelectThenAction(content, () => { applyOnAction(rn); });
    }

    const { url, sectionSlug, bodyText } = this.resolveSrc(attrs, sourceNode);
    if (url || bodyText) this.buildBody(url, sectionSlug, bodyText, attrs, sourceNode);
    else rn.ready();

    this.buildKeyboardHandler(rn.li);

    void expandNode(rn);
  }

  // ── Private methods ────────────────────────────────────────────────────────

  private resolveSrc(
    attrs: ReturnType<typeof resolveAttrs>,
    sourceNode: SourceNode,
  ): { url: string | null; sectionSlug: string | null; bodyText: string | null } {
    const rawSrc = (attrs.get('src') ?? sourceNode.label ?? '').trim();
    if (rawSrc) {
      const hashIdx   = rawSrc.indexOf('#');
      const filePart  = hashIdx === -1 ? rawSrc : rawSrc.slice(0, hashIdx);
      const sectionSlug = hashIdx === -1 ? null : rawSrc.slice(hashIdx);
      return { url: sourceNode.sourceFile.resolveMediaUrl(filePart), sectionSlug, bodyText: null };
    }
    return {
      url: null,
      sectionSlug: null,
      bodyText: sourceNode.bodyLines?.length ? sourceNode.bodyLines.join('\n') : null,
    };
  }

  private buildBody(
    url: string | null,
    sectionSlug: string | null,
    bodyText: string | null,
    attrs: ReturnType<typeof resolveAttrs>,
    sourceNode: SourceNode,
  ): void {
    const { content } = this;
    const outer   = document.createElement('div');
    outer.className = 'md-body';
    const scroller = document.createElement('div');
    scroller.className = 'md-body-scroll';

    scroller.addEventListener('keydown', (e) => {
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && e.target === scroller) {
        content.focus();
        e.preventDefault();
        e.stopPropagation();
      }
    });
    outer.appendChild(scroller);

    // KaTeX is fetched on demand (see ensureKatex in markdown.ts). Math renders
    // synchronously, so it must be loaded BEFORE the markdown is parsed — hence
    // awaiting here rather than upgrading afterwards, which would flash the raw
    // source. The node declares managesReady, so it just does not mount until
    // this settles; MOUNT_SETTLE_MS hides a fast load entirely.
    const renderInto = (src: string) => {
      const { html, spanMap } = mdToHtmlWithSpans(src);
      // Kept for Ctrl+C, which copies the block's markdown source — the same
      // text whether it was written inline or fetched from a file.
      this._src = src;
      scroller.innerHTML = html;
      initOverflowFade(outer, scroller);
      this.wireListboxOptions(scroller, spanMap, attrs, sourceNode);
      this.rn.ready();
    };
    const renderWhenMathReady = (src: string) => {
      if (!hasMath(src) || katexLoaded()) { renderInto(src); return; }
      void ensureKatex().then(() => renderInto(src));
    };

    if (url) {
      fetch(url)
        .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); })
        .then(text => {
          renderWhenMathReady(sectionSlug ? extractMdSection(text, sectionSlug) : text);
        })
        .catch(err => { scroller.textContent = `[${err.message}]`; this.rn.ready(); });
    } else {
      renderWhenMathReady(bodyText!);
    }

    content.appendChild(outer);
  }

  private wireListboxOptions(
    scroller: HTMLElement,
    spanMap: Map<number, ParsedSpanAttrs>,
    attrs: ReturnType<typeof resolveAttrs>,
    sourceNode: SourceNode,
  ): void {
    if (!isListbox(attrs, spanMap)) return;
    const { content, rn } = this;
    content.classList.add('node-content--listbox');
    scroller.setAttribute('role', 'listbox');
    this._listboxNav = wireListbox({
      navRoot:         content,
      optionContainer: scroller,
      spanMap,
      rn,
      sourceNode,
      scrollOnSelect:  true,
      volatile:        attrs.has('listbox-volatile'),
    });

    // Clicking the left border clears the option selection — the same gesture a
    // text node's bullet offers, on the block's own analogue of one. The border
    // is deliberately aligned to the bullet column (see .md-body in styles.css),
    // so this is the same target in the same place.
    //
    // The painted border is only --body-border-w, far too thin to aim at, so the
    // target is a strip as wide as a text node's bullet, centred on the border.
    // Matching the bullet's own hit box is the point: the two gestures should
    // feel identical, not merely exist.
    //
    // A real element, not a pseudo-element or a coordinate test: the strip is
    // then an ordinary event target, so the stylesheet owns its geometry
    // outright and no JS has to reconstruct it. That matters because --bullet-w
    // is themeable — any px/rem/em value an author picks resolves in CSS, where
    // reading it back out would mean parsing a unit this code cannot predict.
    const body = scroller.parentElement;
    if (body?.classList.contains('md-body')) {
      const strip = document.createElement('div');
      strip.className = 'md-body-reset';
      strip.setAttribute('aria-hidden', 'true');   // keyboard path is ArrowLeft
      // No expand: a block node renders no children (this handler never calls
      // setChildren), so its bullet column only ever resets.
      wireBulletActions(strip, content, { listbox: () => this._listboxNav });
      body.appendChild(strip);
    }
  }

  private buildKeyboardHandler(li: HTMLElement): void {
    const { content } = this;
    content.addEventListener('keydown', (e) => {
      if (e.target !== content) return;
      if (listboxKeydown(e, this._listboxNav, this.rn)) return;
      if (actionKeydown(e, this.rn)) return;
      switch (e.key) {
        case 'Enter':
        case ' ':
          this.focusBody();
          e.preventDefault();
          applyOnAction(this.rn);
          return;
        case 'ArrowRight': {
          this.focusBody();
          e.preventDefault();
          return;
        }
        case 'c':
          if (e.ctrlKey || e.metaKey) {
            // Defer to the browser whenever there is a selection to copy.
            if (this._src && !window.getSelection()?.toString()) {
              const body = content.querySelector<HTMLElement>('.md-body-scroll');
              const html = body?.innerHTML ?? '';
              navigator.clipboard.write([
                new ClipboardItem({
                  'text/html':  new Blob([html],       { type: 'text/html' }),
                  'text/plain': new Blob([this._src], { type: 'text/plain' }),
                }),
              ]).catch(() => navigator.clipboard.writeText(this._src!));
              e.preventDefault();
            }
          } else {
            copyPermalink(this.rn);
            e.preventDefault();
          }
          return;
      }
      treeNavKeydown(e, content, li);
    });
  }

  private focusBody(): void {
    const scroller = this.content.querySelector<HTMLElement>('.md-body-scroll');
    if (scroller && scroller.scrollHeight > scroller.clientHeight) {
      scroller.tabIndex = 0;
      scroller.focus();
    }
  }

  // ── TypeHandler interface ──────────────────────────────────────────────────

  onSelect(): void {}
  onDeselect(): void {}
}

const blockFactory: NodeTypeFactory = {
  create(renderNode) {
    return new MarkdownTypeHandler(renderNode);
  },
  staticRenderBody(node, ctx) {
    const rawSrc = (node.attrs.get('src') ?? node.label ?? '').trim();
    if (rawSrc) {
      const hashIdx = rawSrc.indexOf('#');
      const filePart = hashIdx === -1 ? rawSrc : rawSrc.slice(0, hashIdx);
      const sectionSlug = hashIdx === -1 ? null : rawSrc.slice(hashIdx);

      const sourceFile = node.sourceFile;
      if (!sourceFile) return null;
      const targetRel = resolveSiblingPath(sourceFile.address, filePart);
      const text = ctx.readFile(targetRel);
      if (text === null) return `<div class="static-body">[unreadable: ${rawSrc}]</div>`;

      let body: string;
      try { body = sectionSlug ? extractMdSection(text, sectionSlug) : text; }
      catch (e) { return `<div class="static-body">[${(e as Error).message}]</div>`; }
      return `<div class="static-body">${staticMdToHtml(body)}</div>`;
    }
    if (!node.bodyLines?.length) return null;
    return `<div class="static-body">${staticMdToHtml(node.bodyLines.join('\n'))}</div>`;
  },
};

/** Resolve a relative path against a source file's path. Pure string math —
 *  no Node-only APIs, so this is safe to ship in browser bundles. */
function resolveSiblingPath(sourceRel: string, ref: string): string {
  const sourceDir = sourceRel.replace(/[^/]*$/, '');
  const parts: string[] = [];
  for (const p of (sourceDir + ref).split('/')) {
    if (p === '..') parts.pop();
    else if (p !== '.' && p !== '') parts.push(p);
  }
  return parts.join('/');
}

factoryRegister('block', blockFactory);
