/**
 * tr-base.ts
 *
 * Shared base class for tr and table type handlers.
 * Subclasses pass a TrConfig describing their differences.
 */

import type { RenderNode, SourceNode } from '../render-node.js';
import { resolveAttrs, treeNavKeydown, actionKeydown, listboxKeydown, copyPermalink, applyOnSpawn, applyEventAttr, applyOnAction, expandNode, exhibitOpenFromNode, makeToggleBadge, applyBulletProps, applyListItemProps, wireBulletActions } from '../handler-utils.js';
import { BaseTypeHandler } from '../base-handler.js';
import { resolveTransclusionConfig } from '../transclusion.js';
import { mdInlineWithSpansContinued } from '../markdown.js';
import type { ParsedSpanAttrs } from '../markdown.js';
import { wireListbox, isListbox } from '../listbox-utils.js';
import type { ListboxNav } from '../listbox.js';
import { wireSelectThenAction, focusAndScroll } from '../interaction.js';

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
  withExhibit?:      boolean;
  withBullet?:       boolean;
  /** Hook called after li/content setup, before toggle/cells. */
  onSetup?: (ctx: { content: HTMLElement; li: HTMLElement; attrs: ReturnType<typeof resolveAttrs>; sourceNode: SourceNode }) => void;
}

export abstract class TrTypeHandlerBase extends BaseTypeHandler {
  private readonly cfg: TrConfig;
  private _tog!:        HTMLSpanElement;
  private _listboxNav?: ListboxNav;
  private _unwatchChildren?: () => void;

  // Set during construction, used across methods
  private _expandable!:  boolean;
  private _alwaysOpen!:  boolean;
  private _actionVal!:  string | null;
  private _li!:         HTMLElement;

  constructor(rn: RenderNode, cfg: TrConfig) {
    super(rn, cfg.focusableSelector);
    this.cfg = cfg;
    const sourceNode = rn.sourceNode;
    const attrs = resolveAttrs(sourceNode);
    applyOnSpawn(attrs, rn);

    const { content } = this;
    content.classList.add(cfg.contentClass);

    if (cfg.withBullet) {
      applyBulletProps(content, attrs, sourceNode);
      applyListItemProps(content, attrs);
    }

    const li = rn.li;
    this._li = li;
    li.classList.add(cfg.liClass);

    cfg.onSetup?.({ content, li, attrs, sourceNode });

    this._actionVal = cfg.withExhibit ? (attrs.get('action') ?? null) : null;


    const openVal   = attrs.get('open');
    const neverOpen = openVal === 'never';
    const paramOpen = attrs.has('open') && (openVal === '' || openVal === 'true');
    this._alwaysOpen = openVal === 'always';

    const { embedVal, childrenList } = resolveTransclusionConfig(sourceNode, attrs);
    this._expandable   = !neverOpen && (sourceNode.children.length > 0 || !!embedVal || !!childrenList);


    this.buildToggle();
    const hasListbox = this.buildCells(sourceNode, attrs);

    // The bullet expands when it can, and otherwise clears a listbox selection —
    // the same contract as a text node's bullet. Before this, a non-expandable
    // listbox row had no click wiring at all, so its options could only be
    // cleared from the keyboard.
    wireBulletActions(this._tog!, content, {
      expand:  (this._expandable && !this._alwaysOpen)
        ? () => { if (rn.toggleable) this.doToggle(); }
        : undefined,
      listbox: hasListbox ? () => this._listboxNav : undefined,
    });

    // Each doAction also fires on-action, matching the Enter/Space paths in
    // buildKeyboardHandler; the final branch is the leaf case, where on-action
    // is the only thing a re-click does.
    if (this._expandable && !this._alwaysOpen) {
      if (this._actionVal === 'exhibit') {
        wireSelectThenAction(content, () => { exhibitOpenFromNode(rn); applyOnAction(rn); });
      } else {
        wireSelectThenAction(content, (expand) => {
          if (rn.toggleable) this.doToggle(expand);
          applyOnAction(rn);
        });
      }
    } else if (this._actionVal === 'exhibit') {
      wireSelectThenAction(content, () => { exhibitOpenFromNode(rn); applyOnAction(rn); });
    } else {
      wireSelectThenAction(content, () => { applyOnAction(rn); });
    }

    this.buildKeyboardHandler();
    this.buildVisibilityListener();

    if (this._expandable && (paramOpen || this._alwaysOpen)) this.doExpand();
  }

  // ── Expand/collapse ────────────────────────────────────────────────────────

  private doExpand() {
    void expandNode(this.rn);
    for (const v of this.rn.sourceNode.attrs.getAll('on-expand')) applyEventAttr(v, this.rn);
  }
  private doCollapse() {
    for (const v of this.rn.sourceNode.attrs.getAll('on-collapse')) applyEventAttr(v, this.rn);
    this.rn.setChildren([]);
  }
  private doToggle(forceState?: boolean) {
    const open = forceState !== undefined ? forceState : !this.rn.expanded;
    if (open) this.doExpand(); else this.doCollapse();
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
    this._li.insertBefore(tog, rn.children);
    this._tog = tog;
  }

  /** Returns true if this row turned out to be a listbox. */
  private buildCells(sourceNode: SourceNode, attrs: ReturnType<typeof resolveAttrs>): boolean {
    const cells = parseCells(sourceNode.label);
    const spanMap = new Map<number, ParsedSpanAttrs>();
    let nextOrdinal = 0;

    for (const cell of cells) {
      const div = document.createElement('div');
      div.className = this.cfg.cellClass;
      const { html, nextOrdinal: n } = mdInlineWithSpansContinued(cell, spanMap, nextOrdinal);
      div.innerHTML = html;
      nextOrdinal = n;
      this.content.appendChild(div);
    }

    if (!isListbox(attrs, spanMap)) return false;

    const { content, rn } = this;
    content.classList.add('node-content--listbox');
    content.setAttribute('role', 'listbox');
    this._listboxNav = wireListbox({
      navRoot:         content,
      optionContainer: content,
      spanMap,
      rn,
      sourceNode,
      scrollOnSelect:  false,
      volatile:        attrs.has('listbox-volatile'),
    });
    return true;
  }

  private buildKeyboardHandler() {
    const { content, rn, _li: li } = this;
    content.addEventListener('keydown', (e) => {
      if (e.target !== content) return;
      if (listboxKeydown(e, this._listboxNav, rn)) return;
      if (actionKeydown(e, rn)) return;
      const { _expandable: expandable, _alwaysOpen: alwaysOpen } = this;
      switch (e.key) {
        case 'Enter':
        case ' ':
          if (expandable && !alwaysOpen && rn.toggleable) {
            this.doToggle();
          }
          applyOnAction(rn);
          e.preventDefault();
          return;
        case 'ArrowRight':
          if (expandable && rn.toggleable && !rn.expanded) {
            this.doToggle(true);
            e.preventDefault();
          } else if (rn.expanded) {
            focusAndScroll(rn.firstChild()?.contentEl ?? null);
            e.preventDefault();
          }
          return;
        case 'ArrowLeft':
          if (expandable && !alwaysOpen && rn.expanded) {
            this.doCollapse();
          } else {
            focusAndScroll(li.parentElement?.closest<HTMLElement>('.node')?.querySelector<HTMLElement>(':scope > .node-content'));
          }
          e.preventDefault();
          return;
        case 'c':
          if (!e.ctrlKey && !e.metaKey) {
            copyPermalink(rn);
            e.preventDefault();
          }
          return;
      }
      treeNavKeydown(e, content, li);
    });
  }

  private _setExpandable(nowExpandable: boolean) {
    this.setExpandable(nowExpandable, this._tog, () => this.doCollapse());
  }

  private buildVisibilityListener() {
    const { rn, _expandable: expandable, _alwaysOpen: alwaysOpen } = this;
    if (!expandable || alwaysOpen) return;
    if (!rn.sourceNode.children.length) {
      this._setExpandable(true);
      return;
    }
    this._unwatchChildren = rn.watchChildren(rn.sourceNode.children, (nowExpandable) => {
      this._setExpandable(nowExpandable);
    });
  }

  // ── TypeHandler interface ──────────────────────────────────────────────────

  onDestroy(): void {
    this._unwatchChildren?.();
  }
}
