/**
 * span-visibility.ts
 *
 * Conditional visibility for inline spans: `[text]{show-when: &x == "1"}`.
 *
 * The span counterpart to the node-level `show-when` handled by initSlot in
 * render-node.ts, and it reuses that module's parser and evaluator so the two
 * accept exactly one condition grammar.
 *
 * The difference is what "hidden" means. A hidden node is never spawned — it has
 * its own lifecycle to defer. A span is a stretch of already-rendered inline
 * markup with no lifecycle of its own, so it is hidden by removing it from the
 * flow (`display: none`) and revealed by putting it back. Nothing is re-parsed
 * when a condition flips; only the class changes.
 */

import { evalShowWhen, parseShowWhen } from './render-node.js';
import type { ParsedSpanAttrs } from './markdown.js';
import type { StateNode } from './state.js';

/** Set by renderInlineSpan on any span carrying `show-when`. */
const PENDING_CLASS = 'span-conditional-pending';
/** The steady-state hidden marker; styles.css gives it `display: none`. */
const HIDDEN_CLASS  = 'span-hidden';

/**
 * Wire every conditional span under `root` to `state`.
 *
 * Returns a teardown that drops all subscriptions. Callers must invoke it when
 * the owning node is destroyed or the container is re-rendered — subscriptions
 * are held by the state tree, which outlives the DOM, so skipping it would keep
 * dead elements alive and let a later mutation write to a detached node.
 */
export function wireSpanVisibility(
  root:    HTMLElement,
  spanMap: Map<number, ParsedSpanAttrs>,
  state:   StateNode,
): () => void {
  const teardowns: Array<() => void> = [];

  for (const el of root.querySelectorAll<HTMLElement>('[data-rvmark-span]')) {
    const ordinal = parseInt(el.getAttribute('data-rvmark-span')!, 10);
    const raws    = spanMap.get(ordinal)?.getAll('show-when') ?? [];
    if (raws.length === 0) continue;

    // Multiple show-when values are ANDed, matching a node's multi-condition
    // show-when: each raw hides on its own, so any one of them hides the span.
    const isHidden = () => raws.some(sw => evalShowWhen(sw, state));

    const apply = () => {
      el.classList.remove(PENDING_CLASS);
      el.classList.toggle(HIDDEN_CLASS, isHidden());
    };
    apply();

    const keys = [...new Set(raws.flatMap(sw => parseShowWhen(sw)).map(c => c.key))];
    for (const k of keys) {
      state.subscribe(k, apply);
      teardowns.push(() => state.unsubscribe(k, apply));
    }
  }

  return () => { for (const t of teardowns) t(); teardowns.length = 0; };
}
