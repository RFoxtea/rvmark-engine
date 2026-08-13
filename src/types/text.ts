/**
 * types/text.ts
 *
 * Default node type — inline text label with toggle bullet and permalink.
 * Also serves as the fallback when an unrecognised type is encountered.
 */

import type { NodeTypeFactory, SourceNode, ResolvedAttrs } from '../render-node.js';
import { factoryRegister, RenderNode } from '../render-node.js';

import { buildPermalinkHref, copyPermalink, treeNavKeydown, actionKeydown, listboxKeydown, applyOnSpawn, applyOnAction, exhibitOpenFromNode, makeToggleBadge, applyBulletProps, applyListItemProps, wireBulletActions } from '../handler-utils.js';
import { ToggleSet } from '../toggle-set.js';
import { wireSpanToggles } from '../span-toggle.js';
import { resolveAttrs } from '../source-file.js';
import { BaseTypeHandler } from '../base-handler.js';
import { wireListbox, isListbox } from '../listbox-utils.js';
import { wireSpanVisibility } from '../span-visibility.js';
import type { ListboxNav } from '../listbox.js';
import { buildTagChips } from '../tags.js';
import { scrollRowIntoMiddle } from '../scroll.js';
import { mdInlineWithSpans, staticMdInline, ensureKatex, hasMath, katexLoaded, clipboardHtml } from '../markdown.js';
import type { ParsedSpanAttrs } from '../markdown.js';
import { resolveTransclusionConfig } from '../transclusion.js';
import { wireSelectThenAction } from '../interaction.js';

class TextTypeHandler extends BaseTypeHandler {
  private _listboxNav?: ListboxNav;
  private _permalinkAnyFn?: (key: string, value: string | undefined) => void;
  private _unwireSpans?: () => void;
  private _unwireSpanToggles?: () => void;

  // Computed once in constructor, used across methods
  private tog!:        HTMLSpanElement;
  private lbl!:        HTMLSpanElement;
  private toggles!:    ToggleSet;
  // Set only when the label contains math and KaTeX is not loaded yet; read by
  // RenderNode.attach, which skips its own ready() call when this is true.
  managesReady?: true;
  private _reRenderLabel: (() => { html: string; spanMap: Map<number, ParsedSpanAttrs> }) | null = null;

  constructor(rn: RenderNode) {
    // Manual toggle spans are Tab-reachable buttons, so they are gated exactly
    // like links: focusable only while this node is selected. Without them here
    // every citation in the document stays in the tab order at once, which on a
    // page like Euclid's Elements is thousands of stops.
    //
    // Deliberately NOT INTERACTIVE_SPAN_SELECTOR: that names the spans that own
    // their own click, which includes options, and an option must never take DOM
    // focus — listbox.ts drives selection through aria-activedescendant, which
    // real focus on an option would desync. Tab-reachability and click-ownership
    // are different questions with different answers.
    super(rn, '.node-label a[href], .node-label .inline-toggle');
    const sourceNode = rn.sourceNode;
    const attrs = resolveAttrs(sourceNode);
    applyOnSpawn(attrs, rn);

    const hasLink   = attrs.get('action') === 'link';
    const openVal   = attrs.get('open');
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

    this.buildCssProps(attrs, sourceNode);

    const { content } = this;

    const { exhibitButton } = resolveTransclusionConfig(sourceNode, attrs);

    this.buildToggleBullet(sourceNode);
    // Built after the bullet, which it needs; a listbox node is always-open
    // because its children area belongs to the selected option, not the bullet.
    this.toggles = new ToggleSet(rn, attrs, {
      alwaysOpen: openVal === 'always' || hasListbox,
      onExpand:   ({ scroll }) => {
        // This rAF may fire after the node was collapsed/destroyed (the expand
        // is awaited); scrollRowIntoMiddle no-ops on a detached row.
        if (scroll) requestAnimationFrame(() => scrollRowIntoMiddle(this.content));
        if (RenderNode.currentSelection === this.rn) this.activate();
      },
    });
    this._installWatch();
    this.buildLabel(lblHtml, spanMap, hasListbox, hasLink, sourceNode);

    if (hasListbox) this.buildListbox(spanMap, attrs.has('listbox-volatile'), attrs.has('listbox-nonempty'));

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

    // A nonempty listbox cannot be cleared, so the bullet is not offered as a
    // way to clear it — it keeps only whatever expand job it already had.
    this.buildClickWiring(!!exhibitButton, hasListbox && !attrs.has('listbox-nonempty'));
    this.buildKeyboardHandler();

    this.deactivate();

    // Label had math and KaTeX was missing: fetch it, re-render the label with
    // real typesetting, then release the node. The first render above never
    // reaches the screen — the node is unmounted until ready() below.
    if (this._reRenderLabel) {
      void ensureKatex().then(() => {
        const { html, spanMap: freshSpans } = this._reRenderLabel!();
        this.lbl.innerHTML = html;
        const chips = buildTagChips(sourceNode.tags, sourceNode.sourceFile?.tagDefs);
        if (chips.childNodes.length > 0) this.lbl.prepend(chips);
        // innerHTML discarded the wired elements along with the old markup, so
        // the subscriptions must be dropped and re-taken against the new ones.
        this._unwireSpans?.();
        this._unwireSpans = wireSpanVisibility(this.lbl, freshSpans, rn.state);
        this._unwireSpanToggles?.();
        this._unwireSpanToggles = wireSpanToggles(
          this.lbl, freshSpans, attrs, rn, this.toggles,
        );
        // Re-wiring hands the fresh toggles tabIndex 0, so re-apply the gate:
        // focusable only while this node is selected, as at construction.
        if (RenderNode.currentSelection === this.rn) this.activate();
        else this.deactivate();
        this._reRenderLabel = null;
        rn.ready();
      });
    }

    this.toggles.openIfRequested(paramOpen, false);
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

    this._unwireSpans?.();
    this._unwireSpans = wireSpanVisibility(lbl, spanMap, this.rn.state);

    this._unwireSpanToggles?.();
    this._unwireSpanToggles = wireSpanToggles(
      lbl, spanMap, resolveAttrs(sourceNode), this.rn, this.toggles,
    );

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

  private buildListbox(spanMap: Map<number, ParsedSpanAttrs>, volatile: boolean, nonempty: boolean) {
    const { rn, lbl, content } = this;
    this._listboxNav = wireListbox({
      navRoot:         content,
      optionContainer: lbl,
      spanMap,
      rn,
      sourceNode:      rn.sourceNode,
      scrollOnSelect:  false,
      volatile,
      nonempty,
      toggles:         this.toggles,
    });
  }

  onDestroy(): void {
    if (this._permalinkAnyFn) this.rn.state.unsubscribeAny(this._permalinkAnyFn);
    this.toggles.destroy();
    this._unwireSpans?.();
    this._unwireSpanToggles?.();
  }

  private buildClickWiring(exhibitButton: boolean, hasListbox: boolean) {
    const { tog, lbl, content, rn, toggles } = this;

    // The bullet expands when it can, and otherwise clears a listbox selection.
    // wireBulletActions also marks whether it is clickable at all, which is what
    // CSS styles — a leaf with no listbox must not show a pointer.
    wireBulletActions(tog, content, {
      expand:  (toggles.expandable && !toggles.alwaysOpen)
        ? () => { if (toggles.operable) toggles.toggle(undefined, { scroll: false }); }
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
    } else if (toggles.expandable && !toggles.alwaysOpen) {
      wireSelectThenAction(content, (expand) => {
        if (rn.toggleable) toggles.toggle(expand, { scroll: false });
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
    const { content, lbl, rn, toggles } = this;

    content.addEventListener('keydown', (e) => {
      const inMode     = this.modeActive;
      const childrenEl = rn.children;

      if (!inMode && listboxKeydown(e, this._listboxNav, rn)) return;
      if (actionKeydown(e, rn)) return;

      switch (e.key) {
        case 'Enter': {
          if (e.target !== content) break;
          if (toggles.operable) {
            toggles.toggle();
          }
          applyOnAction(rn);
          e.preventDefault();
          break;
        }
        case ' ': {
          if (inMode) break;
          if (toggles.operable) toggles.toggle();
          applyOnAction(rn);
          e.preventDefault();
          break;
        }
        case 'ArrowRight': {
          if (inMode) break;
          if (toggles.alwaysOpen && toggles.expandable) {
            const fc = childrenEl.querySelector<HTMLElement>('.node-content');
            if (fc) { fc.focus(); scrollRowIntoMiddle(fc); }
          } else if (toggles.expandable && rn.toggleable && !rn.expanded) {
            toggles.toggle(true);
          } else if (toggles.expandable) {
            const fc = childrenEl.querySelector<HTMLElement>('.node-content');
            if (fc) { fc.focus(); scrollRowIntoMiddle(fc); }
          }
          e.preventDefault();
          break;
        }
        case 'ArrowLeft': {
          if (inMode) break;
          if (toggles.expandable && !toggles.alwaysOpen && rn.expanded) {
            toggles.close();
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
              const html = clipboardHtml(lbl);
              const lblToText = (l: HTMLElement): string => {
                let out = '';
                for (const child of l.childNodes) {
                  // No trailing space — a real one follows every chip in the DOM.
                  if (child.nodeType === Node.ELEMENT_NODE && (child as HTMLElement).classList?.contains('node-tag'))
                    out += `[${child.textContent}]`;
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

  private _installWatch() {
    this.toggles.installWatch((nowExpandable) => {
      this.setExpandable(nowExpandable, this.tog, () => this.toggles.close());
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
