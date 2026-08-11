/**
 * tr-base.ts
 *
 * Shared base class for tr and table type handlers.
 * Subclasses pass a TrConfig describing their differences.
 */

import type { RenderNode, SourceNode } from '../render-node.js';
import { treeNavKeydown, actionKeydown, listboxKeydown, copyPermalink, applyOnSpawn, applyOnAction, exhibitOpenFromNode, makeToggleBadge, applyBulletProps, applyListItemProps, wireBulletActions } from '../handler-utils.js';
import { ToggleSet } from '../toggle-set.js';
import { wireSpanToggles } from '../span-toggle.js';
import { resolveAttrs } from '../source-file.js';
import { BaseTypeHandler } from '../base-handler.js';
import { mdInlineWithSpansContinued, clipboardHtml } from '../markdown.js';
import type { ParsedSpanAttrs } from '../markdown.js';
import { wireListbox, isListbox } from '../listbox-utils.js';
import { wireSpanVisibility } from '../span-visibility.js';
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
  private _unwireSpans?: () => void;
  private _unwireSpanToggles?: () => void;

  // Set during construction, used across methods
  private _toggles!:    ToggleSet;
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
    const paramOpen = attrs.has('open') && (openVal === '' || openVal === 'true');

    this.buildToggle();
    this._toggles = new ToggleSet(rn, attrs, { alwaysOpen: openVal === 'always' });
    const hasListbox = this.buildCells(sourceNode, attrs);

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
      if (this._actionVal === 'exhibit') {
        wireSelectThenAction(content, () => { exhibitOpenFromNode(rn); applyOnAction(rn); });
      } else {
        wireSelectThenAction(content, (expand) => {
          if (rn.toggleable) this._toggles.toggle(expand);
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
              const text = parseCells(rn.sourceNode.label).join(' | ');
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
