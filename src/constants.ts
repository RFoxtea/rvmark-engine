/**
 * constants.ts
 *
 * Central home for tunable timing constants. Import from here rather than
 * re-typing a literal, so a value is defined in exactly one place.
 */

// Grace period before a not-yet-"ready" subtree is mounted anyway. A load that
// resolves within this window never flashes a loading placeholder — the resolved
// content supersedes the pending mount first; a slower load reveals the
// placeholder once the window elapses. Shared by the root bootstrap (main.ts) and
// every setChildren mount race (render-node.ts), and by the children-mode
// transclusion loading marker, which piggybacks on that same mount race.
export const MOUNT_SETTLE_MS = 250;

// How long a children-mode transclusion waits for its refs to resolve before it
// gives up on the stragglers and renders a per-ref error marker in their place.
// Bounds the wait so one slow/hung ref can't wedge the whole expansion.
export const TRANSCLUDE_DEADLINE_MS = 5000;

// How long a node containing math waits for the on-demand KaTeX load before it
// renders with the plain-text math fallbacks instead. Nodes with math defer their
// mount until KaTeX settles (so nothing flashes raw source and then upgrades), so
// this bound is what stops a hung CDN request from hiding that content for good.
export const KATEX_DEADLINE_MS = 5000;

// How long a guest iframe waits for the host's rvmark-page-context before giving
// up. A host that never posts one would otherwise leave the guest on a promise
// that can only resolve — blank frame, no error, no notice, because init's catch
// never runs. Silence from a counterparty is a failure, not a wait.
export const PAGE_CONTEXT_DEADLINE_MS = 5000;
