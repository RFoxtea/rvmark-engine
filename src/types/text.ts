/**
 * types/text.ts
 *
 * Default node type — inline text label with toggle bullet and permalink.
 * Also serves as the fallback when an unrecognised type is encountered.
 */

import type { NodeTypeFactory, SourceNode, ResolvedAttrs } from '../render-node.js';
import { factoryRegister, RenderNode } from '../render-node.js';

import { resolveAttrs, buildPermalinkHref, copyPermalink, treeNavKeydown, actionKeydown, listboxKeydown, applyOnSpawn, applyEventAttr, applyOnAction, expandNode, exhibitOpenFromNode, makeToggleBadge, applyBulletProps, applyListItemProps, wireBulletActions } from '../handler-utils.js';
import { BaseTypeHandler } from '../base-handler.js';
import { wireListbox, isListbox } from '../listbox-utils.js';
import type { ListboxNav } from '../listbox.js';
import { buildTagChips } from '../tags.js';
import { scrollRowIntoMiddle } from '../scroll.js';
import { mdInlineWithSpans, staticMdInline, ensureKatex, hasMath, katexLoaded } from '../markdown.js';
import type { ParsedSpanAttrs } from '../markdown.js';
import { resolveTransclusionConfig } from '../transclusion.js';
import { wireSelectThenAction } from '../interaction.js';

class TextTypeHandler extends BaseTypeHandler {
  private _listboxNav?: ListboxNav;
  private _permalinkAnyFn?: (key: string, value: string | undefined) => void;
  private _unwatchChildren?: () => void;

  // Computed once in constructor, used across methods
  private tog!:        HTMLSpanElement;
  private lbl!:        HTMLSpanElement;
  private expandable!: boolean;
  private alwaysOpen!: boolean;
  // Set only when the label contains math and KaTeX is not loaded yet; read by
  // RenderNode.attach, which skips its own ready() call when this is true.
  managesReady?: true;
  private _reRenderLabel: (() => { html: string }) | null = null;

  constructor(rn: RenderNode) {
    super(rn, '.node-label a[href]');
    const sourceNode = rn.sourceNode;
    const attrs = resolveAttrs(sourceNode);
    applyOnSpawn(attrs, rn);

    const hasLink   = attrs.get('action') === 'link';
    const openVal   = attrs.get('open');
    const neverOpen = openVal === 'never';
    const paramOpen = attrs.has('open') && (openVal === '' || openVal === 'true');

    // A label containing math needs KaTeX before it renders, or it paints the
    // raw source and then upgrades — a visible flash. Defer readiness (so the
    // node does not mount) and re-render the label once KaTeX lands. Only labels
    // that actually contain math pay this; everything else is untouched, and
    // MOUNT_SETTLE_MS hides a fast load entirely.
    const rawLabel = sourceNode.label || '';
    const needsKatex = hasMath(rawLabel) && !katexLoaded();
    if (needsKatex) this.managesReady = true;

    const renderLabel = () => mdInlineWithSpans(
      rawLabel,
      (url) => sourceNode.sourceFile.resolveMediaUrl(url) ?? null,
    );
    const { html: lblHtml, spanMap } = renderLabel();
    this._reRenderLabel = needsKatex ? renderLabel : null;
    const hasListbox = isListbox(attrs, spanMap);

    this.alwaysOpen = openVal === 'always' || hasListbox;

    this.buildCssProps(attrs, sourceNode);

    const { content } = this;

    const { embedVal, childrenList, exhibitButton } = resolveTransclusionConfig(sourceNode, attrs);
    this.expandable    = !neverOpen && (sourceNode.children.length > 0 || !!embedVal || !!childrenList);

    this.buildToggleBullet(sourceNode);
    this._installWatch();
    this.buildLabel(lblHtml, spanMap, hasListbox, hasLink, sourceNode);

    if (hasListbox) this.buildListbox(spanMap, attrs.has('listbox-volatile'));

    if (sourceNode.attrs.get('id')) {
      const anchor = document.createElement('a');
      anchor.href        = buildPermalinkHref(rn);
      anchor.className   = 'node-id';
      anchor.title       = 'permalink';
      anchor.textContent = '#';
      anchor.tabIndex    = -1;
      content.appendChild(anchor);
      this._permalinkAnyFn = () => { anchor.href = buildPermalinkHref(rn); };
      rn.state.subscribeAny(this._permalinkAnyFn);
    }

    this.buildClickWiring(!!exhibitButton, hasListbox);
    this.buildKeyboardHandler();

    this.deactivate();

    // Label had math and KaTeX was missing: fetch it, re-render the label with
    // real typesetting, then release the node. The first render above never
    // reaches the screen — the node is unmounted until ready() below.
    if (this._reRenderLabel) {
      void ensureKatex().then(() => {
        const { html } = this._reRenderLabel!();
        this.lbl.innerHTML = html;
        const chips = buildTagChips(sourceNode.tags, sourceNode.sourceFile?.tagDefs);
        if (chips.childNodes.length > 0) this.lbl.prepend(chips);
        this._reRenderLabel = null;
        rn.ready();
      });
    }

    if (this.expandable && (paramOpen || this.alwaysOpen)) this.doExpand(false);
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private buildCssProps(attrs: ResolvedAttrs, sourceNode: SourceNode) {
    applyBulletProps(this.content, attrs, sourceNode);
    applyListItemProps(this.content, attrs);
  }

  private buildToggleBullet(_sourceNode: SourceNode) {
    const tog = document.createElement('span');
    tog.className = 'toggle';
    this.tog = tog;

    tog.classList.add('leaf');
    tog.appendChild(makeToggleBadge());
    this.content.appendChild(tog);
  }

  private buildLabel(
    lblHtml: string,
    spanMap: Map<number, ParsedSpanAttrs>,
    hasListbox: boolean,
    hasLink: boolean,
    sourceNode: SourceNode,
  ) {
    const lbl = document.createElement('span');
    lbl.className = 'node-label';
    this.lbl = lbl;

    lbl.innerHTML = lblHtml;
    const chips = buildTagChips(sourceNode.tags, sourceNode.sourceFile?.tagDefs);
    if (chips.childNodes.length > 0) lbl.prepend(chips);

    if (hasListbox) {
      lbl.setAttribute('role', 'listbox');
      for (const el of lbl.querySelectorAll<HTMLElement>('[data-rvmark-span]')) {
        const ordinal = parseInt(el.getAttribute('data-rvmark-span')!, 10);
        const parsed  = spanMap.get(ordinal);
        if (parsed) (el as any)._rvmarkSpan = parsed;
      }
    }

    if (hasLink) {
      lbl.addEventListener('keydown', (e: KeyboardEvent) => {
        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
          this.content.focus();
          e.preventDefault();
          e.stopPropagation();
        } else if (e.key === 'Enter') {
          e.stopPropagation();
        }
      });
    }

    this.content.appendChild(lbl);
  }

  private buildListbox(spanMap: Map<number, ParsedSpanAttrs>, volatile: boolean) {
    const { rn, lbl, content } = this;
    this._listboxNav = wireListbox({
      navRoot:         content,
      optionContainer: lbl,
      spanMap,
      rn,
      sourceNode:      rn.sourceNode,
      scrollOnSelect:  false,
      volatile,
    });
  }

  onDestroy(): void {
    if (this._permalinkAnyFn) this.rn.state.unsubscribeAny(this._permalinkAnyFn);
    this._unwatchChildren?.();
  }

  private buildClickWiring(exhibitButton: boolean, hasListbox: boolean) {
    const { tog, lbl, content, rn, expandable, alwaysOpen } = this;

    // The bullet expands when it can, and otherwise clears a listbox selection.
    // wireBulletActions also marks whether it is clickable at all, which is what
    // CSS styles — a leaf with no listbox must not show a pointer.
    wireBulletActions(tog, content, {
      expand:  (expandable && !alwaysOpen)
        ? () => { if (rn.toggleable) this.doToggle(undefined, { scroll: false }); }
        : undefined,
      listbox: hasListbox ? () => this._listboxNav : undefined,
    });

    // Re-click wiring: exhibit opens the exhibit; otherwise toggle expand/collapse.
    // Every branch fires on-action too, so re-clicking a selected node matches
    // what Enter/Space already do in buildKeyboardHandler.
    const notTog = (el: HTMLElement) => el === tog || tog.contains(el);
    if (exhibitButton) {
      lbl.style.cursor = 'pointer';
      wireSelectThenAction(content, () => { exhibitOpenFromNode(rn); applyOnAction(rn); }, content, notTog);
    } else if (expandable && !alwaysOpen) {
      wireSelectThenAction(content, (expand) => {
        if (rn.toggleable) this.doToggle(expand, { scroll: false });
        else content.focus();
        applyOnAction(rn);
      }, content, notTog);
    } else {
      // Leaf (or always-open) node: nothing type-specific happens on re-click,
      // but it is still an action gesture, so on-action must fire here as well.
      wireSelectThenAction(content, () => { applyOnAction(rn); }, content, notTog);
    }
  }


  private buildKeyboardHandler() {
    const { content, lbl, rn } = this;
    const { expandable, alwaysOpen } = this;

    content.addEventListener('keydown', (e) => {
      const inMode     = this.modeActive;
      const childrenEl = rn.children;

      if (!inMode && listboxKeydown(e, this._listboxNav, rn)) return;
      if (actionKeydown(e, rn)) return;

      switch (e.key) {
        case 'Enter': {
          if (e.target !== content) break;
          if (expandable && !alwaysOpen && rn.toggleable) {
            this.doToggle();
          }
          applyOnAction(rn);
          e.preventDefault();
          break;
        }
        case ' ': {
          if (inMode) break;
          if (expandable && !alwaysOpen && rn.toggleable) this.doToggle();
          applyOnAction(rn);
          e.preventDefault();
          break;
        }
        case 'ArrowRight': {
          if (inMode) break;
          if (alwaysOpen && expandable) {
            const fc = childrenEl.querySelector<HTMLElement>('.node-content');
            if (fc) { fc.focus(); scrollRowIntoMiddle(fc); }
          } else if (expandable && rn.toggleable && !rn.expanded) {
            this.doToggle(true);
          } else if (expandable) {
            const fc = childrenEl.querySelector<HTMLElement>('.node-content');
            if (fc) { fc.focus(); scrollRowIntoMiddle(fc); }
          }
          e.preventDefault();
          break;
        }
        case 'ArrowLeft': {
          if (inMode) break;
          if (expandable && !alwaysOpen && rn.expanded) {
            rn.setChildren([]);
          } else {
            const parent = rn.li.parentElement?.closest<HTMLElement>('li.node')
              ?.querySelector<HTMLElement>(':scope > .node-content');
            if (parent) { parent.focus(); scrollRowIntoMiddle(parent); }
          }
          e.preventDefault();
          break;
        }
        case 'c': {
          if (inMode) break;
          if (e.ctrlKey || e.metaKey) {
            if (!window.getSelection()?.toString()) {
              const html = lbl.innerHTML;
              const lblToText = (l: HTMLElement): string => {
                let out = '';
                for (const child of l.childNodes) {
                  if (child.nodeType === Node.ELEMENT_NODE && (child as HTMLElement).classList?.contains('node-tag'))
                    out += `[${child.textContent}] `;
                  else
                    out += child.textContent ?? '';
                }
                return out.trim();
              };
              const text = lblToText(lbl);
              navigator.clipboard.write([
                new ClipboardItem({
                  'text/html':  new Blob([html],  { type: 'text/html' }),
                  'text/plain': new Blob([text], { type: 'text/plain' }),
                }),
              ]).catch(() => navigator.clipboard.writeText(text));
              e.preventDefault();
            }
          } else {
            copyPermalink(rn);
            e.preventDefault();
          }
          break;
        }
        default:
          if (!inMode) treeNavKeydown(e, content, rn.li);
      }
    });
  }

  // ── Expand/collapse ────────────────────────────────────────────────────────


  private async doExpand(scroll = true) {
    await expandNode(this.rn);
    for (const v of this.rn.sourceNode.attrs.getAll('on-expand')) applyEventAttr(v, this.rn);
    // This rAF may fire after the node was collapsed/destroyed (expandNode is
    // awaited above); scrollRowIntoMiddle no-ops on a detached row.
    if (scroll) requestAnimationFrame(() => scrollRowIntoMiddle(this.content));
    if (RenderNode.currentSelection === this.rn) this.activate();
  }

  private doToggle(forceState?: boolean, opts: { scroll?: boolean } = {}) {
    const scroll = opts.scroll ?? true;
    const open   = forceState !== undefined ? forceState : !this.rn.expanded;
    if (open) this.doExpand(scroll);
    else {
      for (const v of this.rn.sourceNode.attrs.getAll('on-collapse')) applyEventAttr(v, this.rn);
      this.rn.setChildren([]);
    }
  }

  private _setExpandable(nowExpandable: boolean) {
    this.setExpandable(nowExpandable, this.tog, () => this.rn.setChildren([]));
  }

  private _installWatch() {
    if (this.alwaysOpen) return;
    if (!this.rn.sourceNode.children.length) {
      if (this.expandable) this._setExpandable(true);
      return;
    }
    this._unwatchChildren = this.rn.watchChildren(this.rn.sourceNode.children, (nowExpandable) => {
      this._setExpandable(nowExpandable);
    });
  }

  // ── TypeHandler interface ──────────────────────────────────────────────────

}


const textFactory: NodeTypeFactory = {
  defaultOpen: false,
  create(renderNode) {
    return new TextTypeHandler(renderNode);
  },
  staticRenderBody() {
    return null;
  },
};

factoryRegister('text', textFactory);

export function staticRenderTextLabel(label: string): string {
  return staticMdInline(label || '');
}
