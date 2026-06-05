/**
 * types/markdown.ts
 *
 * Implements the `block` node type: a multiline Markdown body rendered inside a
 * node. Body lines collected by the parser (collectsBody: true). Supports:
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
import { resolveAttrs, treeNavKeydown, actionKeydown, listboxKeydown, copyPermalink, applyOnSpawn, applyExhibit, applyEventAttr, expandNode, exhibitOpenFromNode } from '../handler-utils.js';
import { BaseTypeHandler } from '../base-handler.js';
import { wireListbox, isListbox } from '../listbox-utils.js';
import type { ListboxNav } from '../listbox.js';
import { wireSelectThenToggle } from '../interaction.js';
import { mdToHtmlWithSpans, staticMdToHtml } from '../markdown.js';
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

  constructor(rn: RenderNode) {
    super(rn, 'a[href], pre, .md-body-scroll, .md-math-block, .katex-display, .katex-html');
    const sourceNode = rn.sourceNode;
    const attrs = resolveAttrs(sourceNode);
    applyOnSpawn(attrs, rn);

    const { content } = this;
    applyExhibit(rn, attrs);

    this._actionVal = attrs.get('action') ?? null;
    if (this._actionVal === 'exhibit') {
      wireSelectThenToggle(content, () => exhibitOpenFromNode(rn));
    } else {
      wireSelectThenToggle(content, () => {});
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

    if (url) {
      fetch(url)
        .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); })
        .then(text => {
          const resolved = sectionSlug ? extractMdSection(text, sectionSlug) : text;
          const { html, spanMap } = mdToHtmlWithSpans(resolved);
          scroller.innerHTML = html;
          initOverflowFade(outer, scroller);
          this.wireListboxOptions(scroller, spanMap, attrs, sourceNode);
          this.rn.ready();
        })
        .catch(err => { scroller.textContent = `[${err.message}]`; this.rn.ready(); });
    } else {
      const { html, spanMap } = mdToHtmlWithSpans(bodyText!);
      scroller.innerHTML = html;
      initOverflowFade(outer, scroller);
      this.wireListboxOptions(scroller, spanMap, attrs, sourceNode);
      this.rn.ready();
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
          for (const v of this.rn.sourceNode.attrs.getAll('on-action')) applyEventAttr(v, this.rn);
          return;
        case 'ArrowRight': {
          this.focusBody();
          e.preventDefault();
          return;
        }
        case 'c':
          if (!e.ctrlKey && !e.metaKey) {
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
  collectsBody: true,
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
