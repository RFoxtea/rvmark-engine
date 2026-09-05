/**
 * tr-base.ts
 *
 * Shared base class for tr and table type handlers.
 * Subclasses pass a TrConfig describing their differences.
 */

import type { RenderNode, RvNode } from '../client/render-node.js';
import { treeNavKeydown, actionKeydown, listboxKeydown, copyPermalink, applyOnSpawn, applyOnAction, sidepanelOpenFromNode, makeToggleBadge, applyBulletProps, applyBulletAlt, applyListItemProps, wireBulletActions } from '../client/handler-utils.js';
import { ToggleSet } from '../client/toggle-set.js';
import { wireSpanToggles } from '../client/span-toggle.js';
import type { ResolvedAttrs } from '../shared/parser.js';
import { BaseTypeHandler } from '../client/base-handler.js';
import { mdInlineWithSpansContinued, mdInlineWithSpansContinuedUsing, collectInlineRefs,
         ensureKatex, hasMath, katexLoaded, clipboardHtml } from '../client/markdown.js';
import type { ParsedSpanAttrs } from '../client/markdown.js';
import { wireListbox, isListbox } from '../client/listbox-utils.js';
import { wireSpanVisibility } from '../client/span-visibility.js';
import type { ListboxNav } from '../client/listbox.js';
import { wireSelectThenAction, focusAndScroll } from '../client/interaction.js';
import { resolveMediaAllOn } from '../client/origin-host.js';

export const CELL_SEP = /\s*\|\s*/;

export function parseCells(label: string): string[] {
  return label.split(CELL_SEP).map(s => s.trim()).filter((s, i, a) => i < a.length - 1 || s !== '');
}

export interface TrConfig {
  liClass:           string;
  toggleClass:       string;
  cellClass:         string;
  contentClass:      string;
  focusableSelector: string;
  withSidepanel?:      boolean;
  withBullet?:       boolean;
  /** Hook called after li/content setup, before toggle/cells. */
  onSetup?: (ctx: { content: HTMLElement; li: HTMLElement; attrs: ResolvedAttrs; rvNode: RvNode }) => void;
}

export abstract class TrTypeHandlerBase extends BaseTypeHandler {
  private readonly cfg: TrConfig;
  private _tog!:        HTMLSpanElement;
  private _listboxNav?: ListboxNav;
  private _unwireSpans?: () => void;
  private _unwireSpanToggles?: () => void;

  // Set during construction, used across methods
  private _toggles!:    ToggleSet;
  private _actionVal!:  string | null;
  private _li!:         HTMLElement;

  constructor(rn: RenderNode, cfg: TrConfig) {
    super(rn, cfg.focusableSelector);
    this.cfg = cfg;
    const rvNode = rn.rvNode;
    const attrs = rvNode.attrs;
    applyOnSpawn(attrs, rn);

    const { content } = this;
    content.classList.add(cfg.contentClass);

    if (cfg.withBullet) {
      applyBulletProps(content, attrs, rvNode);
      applyListItemProps(content, attrs);
    }

    const li = rn.li;
    this._li = li;
    li.classList.add(cfg.liClass);

    cfg.onSetup?.({ content, li, attrs, rvNode });

    this._actionVal = cfg.withSidepanel ? (attrs.get('action') ?? null) : null;


    const openVal   = attrs.get('open');
    const paramOpen = attrs.has('open') && (openVal === '' || openVal === 'true');

    this.buildToggle();
    this._toggles = new ToggleSet(rn, attrs, { alwaysOpen: openVal === 'always' });
    const hasListbox = this.buildCells(rvNode, attrs);

    // A row's cells can be provisional for the same two reasons a text label
    // can be (see types/text.ts): math needing KaTeX, and a span's `img:` ref
    // needing the origin. One re-render settles both, so typesetting and
    // resolved URLs never paint over each other.
    const rawCells  = parseCells(rvNode.label);
    const needsKatex = rawCells.some(c => hasMath(c)) && !katexLoaded();
    const imgRefs    = collectInlineRefs(rawCells);
    if (needsKatex || imgRefs.length) {
      rn.holdReady(this._settleCells(rvNode, attrs, needsKatex, imgRefs));
    }

    // The bullet expands when it can, and otherwise clears a listbox selection —
    // the same contract as a text node's bullet. Before this, a non-expandable
    // listbox row had no click wiring at all, so its options could only be
    // cleared from the keyboard.
    wireBulletActions(this._tog!, content, {
      expand:  (this._toggles.expandable && !this._toggles.alwaysOpen)
        ? () => { if (this._toggles.operable) this._toggles.toggle(); }
        : undefined,
      listbox: hasListbox ? () => this._listboxNav : undefined,
    });

    // Each doAction also fires on-action, matching the Enter/Space paths in
    // buildKeyboardHandler; the final branch is the leaf case, where on-action
    // is the only thing a re-click does.
    if (this._toggles.expandable && !this._toggles.alwaysOpen) {
      if (this._actionVal === 'sidepanel') {
        wireSelectThenAction(content, () => { sidepanelOpenFromNode(rn); applyOnAction(rn); });
      } else {
        wireSelectThenAction(content, (expand) => {
          if (rn.toggleable) this._toggles.toggle(expand);
          applyOnAction(rn);
        }, content, undefined,
        () => rn.toggleable || attrs.has('on-action'));
      }
    } else if (this._actionVal === 'sidepanel') {
      wireSelectThenAction(content, () => { sidepanelOpenFromNode(rn); applyOnAction(rn); });
    } else {
      // Leaf row: on-action or nothing. A cell of table text should be
      // double-click selectable when the row does nothing.
      wireSelectThenAction(
        content, () => { applyOnAction(rn); }, content, undefined,
        () => attrs.has('on-action'),
      );
    }

    this.buildKeyboardHandler();
    this.buildVisibilityListener();

    this._toggles.openIfRequested(paramOpen);
  }


  // ── Build steps ────────────────────────────────────────────────────────────

  // Builds the element only; the click wiring needs buildCells' answer about
  // whether this row is a listbox, so it happens once, afterwards.
  private buildToggle() {
    const { rn, cfg } = this;
    const tog = document.createElement('span');
    tog.className = `${cfg.toggleClass} toggle`;
    tog.classList.add('leaf');
    tog.appendChild(makeToggleBadge());
    applyBulletAlt(this.content, tog);
    this._li.insertBefore(tog, rn.children);
    this._tog = tog;
  }

  /**
   * Wait for whatever the cells were missing, then re-render and re-wire them.
   *
   * Always settles: this promise gates the row's reveal, so a failed resolve
   * leaves the first render standing rather than hanging the node.
   */
  private async _settleCells(
    rvNode: RvNode,
    attrs: ResolvedAttrs,
    needsKatex: boolean,
    imgRefs: string[],
  ): Promise<void> {
    try {
      if (needsKatex) await ensureKatex();
      const answers = imgRefs.length
        ? await resolveMediaAllOn(rvNode, imgRefs)
        : [];
      const resolved = new Map(imgRefs.map((ref, i) => [ref, answers[i] ?? null]));
      this.buildCells(rvNode, attrs, resolved);
    } catch { /* the first render stands, and is what stays wired */ }
  }

  /** Returns true if this row turned out to be a listbox. */
  private buildCells(
    rvNode: RvNode,
    attrs: ResolvedAttrs,
    resolved: Map<string, string | null> | null = null,
  ): boolean {
    const cells = parseCells(rvNode.label);
    const spanMap = new Map<number, ParsedSpanAttrs>();
    let nextOrdinal = 0;

    // Re-rendering replaces the row's cells, so clear what a first pass built.
    for (const old of [...this.content.querySelectorAll(`.${this.cfg.cellClass}`)]) {
      old.remove();
    }

    for (const cell of cells) {
      const div = document.createElement('div');
      div.className = this.cfg.cellClass;
      const { html, nextOrdinal: n } = resolved
        ? mdInlineWithSpansContinuedUsing(cell, spanMap, nextOrdinal, resolved)
        : mdInlineWithSpansContinued(cell, spanMap, nextOrdinal);
      div.innerHTML = html;
      nextOrdinal = n;
      this.content.appendChild(div);
    }

    // Wired before the listbox check: every cell of the row shares one spanMap
    // and one content element, and a conditional cell is meaningful whether or
    // not the row is also a listbox.
    this._unwireSpans?.();
    this._unwireSpans = wireSpanVisibility(this.content, spanMap, this.rn.state);

    this._unwireSpanToggles?.();
    this._unwireSpanToggles = wireSpanToggles(
      this.content, spanMap, attrs, this.rn, this._toggles,
    );

    if (!isListbox(attrs, spanMap)) return false;

    const { content, rn } = this;
    content.classList.add('node-content--listbox');
    content.setAttribute('role', 'listbox');
    this._listboxNav = wireListbox({
      navRoot:         content,
      optionContainer: content,
      spanMap,
      rn,
      rvNode,
      scrollOnSelect:  false,
      volatile:        attrs.has('listbox-volatile'),
      nonempty:        attrs.has('listbox-nonempty'),
      toggles:         this._toggles,
    });
    return true;
  }

  private buildKeyboardHandler() {
    const { content, rn, _li: li } = this;
    content.addEventListener('keydown', (e) => {
      if (e.target !== content) return;
      if (listboxKeydown(e, this._listboxNav, rn)) return;
      if (actionKeydown(e, rn)) return;
      const toggles = this._toggles;
      switch (e.key) {
        case 'Enter':
        case ' ':
          if (toggles.operable) {
            toggles.toggle();
          }
          applyOnAction(rn);
          e.preventDefault();
          return;
        case 'ArrowRight':
          if (toggles.expandable && rn.toggleable && !rn.expanded) {
            toggles.toggle(true);
            e.preventDefault();
          } else if (rn.expanded) {
            focusAndScroll(rn.firstChild()?.contentEl ?? null);
            e.preventDefault();
          }
          return;
        case 'ArrowLeft':
          if (toggles.expandable && !toggles.alwaysOpen && rn.expanded) {
            toggles.close();
          } else {
            focusAndScroll(li.parentElement?.closest<HTMLElement>('.node')?.querySelector<HTMLElement>(':scope > .node-content'));
          }
          e.preventDefault();
          return;
        case 'c':
          if (e.ctrlKey || e.metaKey) {
            // Defer to the browser whenever there is a selection to copy.
            if (!window.getSelection()?.toString()) {
              // Plain text is the row as it is written on the site: cells
              // joined by '|', normalised through the same parse the cells
              // themselves came from.
              const text = parseCells(rn.rvNode.label).join(' | ');
              const html = [...content.querySelectorAll<HTMLElement>(`.${this.cfg.cellClass}`)]
                .map(c => clipboardHtml(c)).join(' | ');
              navigator.clipboard.write([
                new ClipboardItem({
                  'text/html':  new Blob([html], { type: 'text/html' }),
                  'text/plain': new Blob([text], { type: 'text/plain' }),
                }),
              ]).catch(() => navigator.clipboard.writeText(text));
              e.preventDefault();
            }
          } else {
            copyPermalink(rn);
            e.preventDefault();
          }
          return;
      }
      treeNavKeydown(e, content, li);
    });
  }

  private buildVisibilityListener() {
    this._toggles.installWatch((nowExpandable) => {
      this.setExpandable(nowExpandable, this._tog, () => this._toggles.close());
    });
  }

  // ── TypeHandler interface ──────────────────────────────────────────────────

  onDestroy(): void {
    this._toggles.destroy();
    this._unwireSpans?.();
    this._unwireSpanToggles?.();
  }
}
