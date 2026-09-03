/**
 * types/text.ts
 *
 * Default nodetype — inline text label with toggle bullet and permalink.
 * Also serves as the fallback when an unrecognised type is encountered.
 */

import './text.declare.js';
import type { NodeTypeFactory, SourceNode, ResolvedAttrs, StaticBuildContext } from '../client/render-node.js';
import { factoryRegister, RenderNode } from '../client/render-node.js';

import { buildPermalinkHref, copyPermalink, treeNavKeydown, actionKeydown, listboxKeydown, applyOnSpawn, applyOnAction, sidepanelOpenFromNode, makeToggleBadge, applyBulletProps, applyBulletAlt, applyListItemProps, wireBulletActions } from '../client/handler-utils.js';
import { ToggleSet } from '../client/toggle-set.js';
import { wireSpanToggles } from '../client/span-toggle.js';
import { BaseTypeHandler } from '../client/base-handler.js';
import { wireListbox, isListbox } from '../client/listbox-utils.js';
import { wireSpanVisibility } from '../client/span-visibility.js';
import type { ListboxNav } from '../client/listbox.js';
import { buildTagChips } from '../client/tag-chips.js';
import { scrollRowIntoMiddle } from '../client/scroll.js';
import { mdInlineWithSpans, mdInlineWithSpansResolved, ensureKatex, hasMath, katexLoaded, clipboardHtml } from '../client/markdown.js';
import type { ParsedSpanAttrs } from '../client/markdown.js';
import { resolveTransclusionConfig } from '../client/transclusion.js';
import { wireSelectThenAction } from '../client/interaction.js';
import { resolveMediaAllOn } from '../client/origin-host.js';

type LabelRender = { html: string; spanMap: Map<number, ParsedSpanAttrs> };

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
  // The final render of the label, when the first one was provisional. Async
  // only in the case that needs the origin.
  private _reRenderLabel:
    | (() => LabelRender | Promise<LabelRender>)
    | null = null;
  // The spans of the markup currently in the label, and whether those spans are
  // a listbox. Wiring reads them rather than taking them as arguments, so it
  // cannot be handed the map of markup that is no longer there.
  private _spanMap: Map<number, ParsedSpanAttrs> = new Map();
  private _hasListbox = false;

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
    const attrs = sourceNode.attrs;
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

    const { html: lblHtml, spanMap } = mdInlineWithSpans(rawLabel);
    const hasListbox = isListbox(attrs, spanMap);
    this._hasListbox = hasListbox;

    // Two things can make that first render provisional: math needing KaTeX,
    // and a span's `img:` ref needing the origin. Both are settled by ONE
    // re-render rather than two racing ones — a KaTeX pass that did not also
    // resolve images would paint typesetting over resolved URLs, and the
    // reverse would paint resolved URLs over typesetting.
    //
    // Neither flashes. `managesReady` and `holdReady` both keep the node
    // unmounted until the second render lands, so the first never reaches the
    // screen. The hold is raced against the shared reveal deadline, so an
    // origin that never answers costs one deadline and then shows the authored
    // ref — what it showed before it resolved at all.
    const needsImg = [...spanMap.values()].some(a => a.get('img'));
    const provisional = needsKatex || needsImg;
    if (provisional) this._reRenderLabel = () => this._renderLabelFinal(rawLabel, needsImg);

    this.buildCssProps(attrs, sourceNode);

    const { content } = this;

    const { sidepanelButton } = resolveTransclusionConfig(sourceNode, attrs);

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

    // A provisional label is wired when its final markup lands, not twice: the
    // options, toggles and subscriptions all hang off elements `innerHTML` is
    // about to discard, and a listbox wired against discarded elements is the
    // shape of the bug this replaced — dead options carrying no id, no
    // selection and no click handler.
    if (!provisional) this._wireLabel(attrs);

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
    this.buildClickWiring(!!sidepanelButton, hasListbox && !attrs.has('listbox-nonempty'));
    this.buildKeyboardHandler();

    this.deactivate();

    // Only the KaTeX case releases readiness itself, because it declared
    // managesReady and so nothing else will. The image-only case takes a hold
    // instead, and attachHandler's own ready() still applies. Either way the
    // hold is taken here, after the row is built, so the settle finds a label
    // to wire.
    if (needsKatex) void this._settleLabel(sourceNode, attrs).then(() => rn.ready());
    else if (needsImg) rn.holdReady(this._settleLabel(sourceNode, attrs));

    this.toggles.openIfRequested(paramOpen, false);
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Paint markup into the label. Wiring is NOT done here — `innerHTML`
   * discards the elements everything hangs off, so what is wired is always
   * whatever markup was painted last, and `_wireLabel` is the one place that
   * does it.
   */
  private _paintLabel(html: string, spanMap: Map<number, ParsedSpanAttrs>, sourceNode: SourceNode): void {
    this.lbl.innerHTML = html;
    const chips = buildTagChips(sourceNode.tags);
    if (chips.childNodes.length > 0) this.lbl.prepend(chips);
    this._spanMap = spanMap;
  }

  /**
   * Wire the markup standing in the label: conditional spans, span toggles,
   * and — when those spans are a listbox — the options themselves.
   *
   * Called once per node, against the markup that mounts. A provisional render
   * waits for its final one rather than wiring twice: the listbox half cannot
   * simply be re-taken, because `wireListbox` also registers a listener on the
   * row, which is not replaced and would accumulate one nav per render.
   */
  private _wireLabel(attrs: ResolvedAttrs): void {
    const { lbl, rn } = this;
    const spanMap = this._spanMap;

    if (this._hasListbox) {
      for (const el of lbl.querySelectorAll<HTMLElement>('[data-rvmark-span]')) {
        const ordinal = parseInt(el.getAttribute('data-rvmark-span')!, 10);
        const parsed  = spanMap.get(ordinal);
        if (parsed) (el as any)._rvmarkSpan = parsed;
      }
    }

    this._unwireSpans?.();
    this._unwireSpans = wireSpanVisibility(lbl, spanMap, rn.state);

    this._unwireSpanToggles?.();
    this._unwireSpanToggles = wireSpanToggles(lbl, spanMap, attrs, rn, this.toggles);

    if (this._hasListbox) {
      this.buildListbox(spanMap, attrs.has('listbox-volatile'), attrs.has('listbox-nonempty'));
    }

    // Wiring hands the fresh toggles tabIndex 0, so apply the gate: focusable
    // only while this node is selected.
    if (RenderNode.currentSelection === this.rn) this.activate();
    else this.deactivate();
  }

  /**
   * The label as it should finally appear. KaTeX takes no argument — by the
   * time this runs it is loaded, and both renderers pick it up off the global —
   * so the only branch is whether the origin has to be asked about an `img:`.
   */
  private _renderLabelFinal(rawLabel: string, needsImg: boolean): LabelRender | Promise<LabelRender> {
    return needsImg
      ? mdInlineWithSpansResolved(rawLabel, (refs) => resolveMediaAllOn(this.rn.sourceNode, refs))
      : mdInlineWithSpans(rawLabel);
  }

  /**
   * Wait for whatever the label was missing, then paint it and wire the label.
   *
   * Always settles, and always wires: this promise gates the node's reveal, so
   * a failed resolve must leave the first render standing — wired, or the node
   * mounts with dead spans — rather than hang.
   */
  private async _settleLabel(sourceNode: SourceNode, attrs: ResolvedAttrs): Promise<void> {
    try {
      if (this.managesReady) await ensureKatex();
      const { html, spanMap } = await this._reRenderLabel!();
      this._paintLabel(html, spanMap, sourceNode);
    } catch { /* the first render stands, and is what gets wired */ }
    this._reRenderLabel = null;
    this._wireLabel(attrs);
  }

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
    applyBulletAlt(this.content, tog);
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

    this._paintLabel(lblHtml, spanMap, sourceNode);

    // On the label itself, so it survives a re-render's innerHTML.
    if (hasListbox) lbl.setAttribute('role', 'listbox');

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

  private buildClickWiring(sidepanelButton: boolean, hasListbox: boolean) {
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

    // Re-click wiring: sidepanel opens the sidepanel; otherwise toggle expand/collapse.
    // Every branch fires on-action too, so re-clicking a selected node matches
    // what Enter/Space already do in buildKeyboardHandler.
    const notTog = (el: HTMLElement) => el === tog || tog.contains(el);
    if (sidepanelButton) {
      lbl.style.cursor = 'pointer';
      wireSelectThenAction(content, () => { sidepanelOpenFromNode(rn); applyOnAction(rn); }, content, notTog);
    } else if (toggles.expandable && !toggles.alwaysOpen) {
      wireSelectThenAction(content, (expand) => {
        if (rn.toggleable) toggles.toggle(expand, { scroll: false });
        else content.focus();
        applyOnAction(rn);
      }, content, notTog,
      // Toggleability is not fixed at wiring time — a node becomes expandable
      // once its children resolve — so this is asked per gesture.
      () => rn.toggleable || rn.sourceNode.attrs.has('on-action'));
    } else {
      // Leaf (or always-open) node: nothing type-specific happens on re-click,
      // but it is still an action gesture, so on-action must fire here as well.
      // If the node declares no on-action there is nothing to protect, and the
      // reader gets ordinary double-click-to-select back.
      //
      // {action: link} needs no exception: the anchor is a real <a>, which both
      // handlers skip outright, so a click that reaches here landed beside the
      // link and does nothing. {action: none} is inert by definition.
      wireSelectThenAction(
        content, () => { applyOnAction(rn); }, content, notTog,
        () => rn.sourceNode.attrs.has('on-action'),
      );
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

// ── Static bullet ─────────────────────────────────────────────────────────────
// Build-time twin of buildToggleBullet + makeToggleBadge + applyBulletAlt.
//
// Lives here, not in the site builder, because drawing a bullet is a property
// of the types that have one — text and the tr/table family, which share it the
// same way they share applyBulletProps in the hydrated path. Types with no
// bullet (block, image, hr, gap, video, iframe) never call this, which is
// exactly how they opt out in the DOM: by not calling buildToggleBullet.
//
// `escape` is passed in rather than imported so this stays free of any
// Node-only dependency — the module is loaded by the browser bundle too.
export function staticRenderBullet(
  isLeaf:    boolean,
  bulletAlt: string | null,
  escape:    (s: string) => string,
): string {
  // The alt name is real text rather than aria-label: .toggle is a bare span
  // with no role, and aria-label on a roleless element is widely ignored. The
  // trailing space keeps it from running into the label in the flat string a
  // screen reader builds from the row.
  const alt = bulletAlt
    ? `<span class="visually-hidden">${escape(bulletAlt)} </span>`
    : '';
  return `<span class="toggle${isLeaf ? ' leaf' : ''}">${alt}<span class="toggle-badge" aria-hidden="true"></span></span>`;
}

// The CSS custom properties and classes the bullet rules read — the static twin
// of applyBulletProps + applyListItemProps. Returns plain data so the caller can
// merge it into whatever element it is building.
//
// Unlike the hydrated path there is no load probe: a build cannot observe a
// dead icon URL, so a broken {bullet} leaves an empty gutter here where the
// hydrated page would fall back to the default marker.
export function staticBulletProps(
  node:  SourceNode,
  attrs: ResolvedAttrs,
  ctx:   StaticBuildContext,
): { classes: string[]; styles: string[]; bulletAlt: string | null } {
  const classes: string[] = [];
  const styles:  string[] = [];

  const bullet = attrs.get('bullet');
  if (bullet !== undefined) {
    const url = ctx.resolveMedia(node, bullet);
    if (url) {
      classes.push('node-content--bullet-image');
      styles.push(`--node-bullet-image:url("${url.replace(/[\\"]/g, '\\$&')}")`);
      const open = attrs.get('bullet-open');
      if (open !== undefined) {
        const openUrl = ctx.resolveMedia(node, open);
        if (openUrl) {
          classes.push('node-content--bullet-open');
          styles.push(`--node-bullet-image-open:url("${openUrl.replace(/[\\"]/g, '\\$&')}")`);
        }
      }
    }
  }
  if (attrs.has('bullet-spins')) classes.push('node-content--bullet-spins');

  // Only list-item types may be numbered — a divider must not carry .li or it
  // would consume a list number via the CSS counter (see applyListItemProps).
  if (attrs.has('li')) {
    classes.push('li');
    const raw = attrs.get('li');
    if (raw) {
      const n = Number.parseInt(raw, 10);
      if (Number.isFinite(n)) styles.push(`--li-start:${n}`);
    }
  }

  return { classes, styles, bulletAlt: attrs.get('bullet-alt') ?? null };
}
