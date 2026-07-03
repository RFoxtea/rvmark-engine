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
