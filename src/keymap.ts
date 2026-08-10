/**
 * keymap.ts
 *
 * The "controls" panel: a modal listing of the tree's keyboard bindings,
 * opened from a row in the footer view menu (see shell.ts).
 *
 * The keys themselves are the engine's, so the list lives here rather than in
 * any one site's content — a site that documents navigation in its own prose
 * still gets a keymap that cannot fall out of step with the handlers.
 *
 * ── Filling in the descriptions ───────────────────────────────────────────────
 * Every `desc` below is deliberately empty, and the panel is deliberately
 * readable with them empty: a row with no description renders its keys alone.
 * Write the wording in KEYMAP and nowhere else. Rows whose `desc` is still ''
 * are shown, so a half-filled table looks unfinished rather than silently
 * dropping bindings; set `desc: null` to omit a row entirely.
 *
 * Key labels are rendered verbatim in <kbd> — see KeymapRow.keys for how a
 * gesture is spelled. They are the one part of this file that must track the
 * code: they mirror the handlers in types/text.ts (arrows, Enter, Space, c),
 * handler-utils.ts (treeNavKeydown, actionKeydown, listboxKeydown),
 * interaction.ts (Escape) and search.ts (Ctrl+F).
 */

// Ctrl and ⌘ are physically different keycaps, so the label follows the
// platform even though the handlers accept either modifier (search.ts tests
// `ctrlKey || metaKey`). userAgentData.platform is the supported API;
// navigator.platform is deprecated and under-reports on newer Chrome, so it is
// only the fallback for browsers that have not shipped the former.
//
// Alt is deliberately not branched: Mac keycaps print "option"/"⌥" but also
// "alt", so one label reads correctly on both.
const isMac = (): boolean => {
  const uaPlatform = (navigator as any).userAgentData?.platform;
  if (typeof uaPlatform === 'string') return /mac/i.test(uaPlatform);
  return /mac/i.test(navigator.platform ?? '');
};
const MOD = isMac() ? '⌘' : 'Ctrl';

export interface KeymapRow {
  /**
   * The gesture, as groups of keys. Two levels, two joiners:
   *   outer — keys pressed together, joined by '+'
   *   inner — interchangeable keys, joined by '/'
   *
   *   [['Home']]              → Home
   *   [['↑', '↓']]            → ↑/↓
   *   [[MOD], ['c']]          → Ctrl + c
   *   [['Alt'], ['↑', '↓']]   → Alt + ↑/↓
   *
   * Every key is its own <kbd>; the joiners are text between the boxes, so a
   * keycap always shows a key that actually exists.
   */
  keys: string[][];
  /** Written by the site author. '' renders the keys with no description; null omits the row. */
  desc: string | null;
}

export interface KeymapSection {
  /** Written by the site author. '' renders an unlabelled group. */
  title: string;
  rows: KeymapRow[];
}

// The bindings, grouped as they are worth reading rather than as they are
// implemented. Descriptions are the author's to write — see the file header.
export const KEYMAP: KeymapSection[] = [
  {
    title: 'Navigation',
    rows: [
      { keys: [['↑', '↓']],          desc: 'Move to previous or next node.' },
      { keys: [['Alt'], ['↑', '↓']], desc: 'Move to previous or next sibling node.' },
      { keys: [['→']],               desc: 'Move right. / Expand node.' },
      { keys: [['←']],               desc: 'Move left. / Collapse node.' },
      { keys: [['Home']],            desc: 'Move to first node in tree.' },
      { keys: [['End']],             desc: 'Move to last node in tree.' },
      { keys: [['Enter']],           desc: 'Toggle node expansion. / Interact.' },
      { keys: [['Space']],           desc: 'Toggle node expansion. / Interact.' },
      { keys: [['Esc']],             desc: 'Close sidepanel.' },
    ],
  },
  {
    title: 'Copying',
    rows: [
      { keys: [['c']],               desc: 'Copy node permalink.' },
      { keys: [[MOD], ['c']],        desc: 'Copy node content.' },
    ],
  },
  // Search keys are their own group: Enter and Shift+Enter step through
  // matches only while the search box has focus, and a bare 'Enter' row
  // alongside the tree's own Enter would otherwise read as the same binding.
  {
    title: 'Search',
    rows: [
      { keys: [[MOD], ['f']],        desc: 'Open finder.' },
      { keys: [['Enter']],           desc: 'Focus next result.' },
      { keys: [['Shift'], ['Enter']], desc: 'Focus previous result.' },
    ],
  },
];

let dialog: HTMLDialogElement | null = null;

function build(): HTMLDialogElement {
  const d = document.createElement('dialog');
  d.className = 'keymap-dialog';
  d.setAttribute('aria-label', 'Keyboard controls');

  const body = document.createElement('div');
  body.className = 'keymap-body';

  for (const section of KEYMAP) {
    const rows = section.rows.filter(r => r.desc !== null);
    if (!rows.length) continue;

    const group = document.createElement('section');
    group.className = 'keymap-section';

    // An empty title is a real state (the author has not written one yet), not
    // a missing heading — so the element is skipped rather than left blank,
    // which would otherwise open every group with a stray gap.
    if (section.title) {
      const h = document.createElement('h2');
      h.className = 'keymap-section-title';
      h.textContent = section.title;
      group.appendChild(h);
    }

    const dl = document.createElement('dl');
    dl.className = 'keymap-rows';
    for (const row of rows) {
      const dt = document.createElement('dt');
      dt.className = 'keymap-keys';

      // Joiners sit between <kbd>s, never inside one: a keycap must show a key
      // that exists, so '+' and '/' are their own elements outside the boxes
      // they separate. Outer groups chord with '+', keys within a group are
      // interchangeable and read with '/'. Wrapped in a span (rather than left
      // as bare text) so they can be spaced and de-emphasised in CSS without
      // touching the keycaps' own metrics.
      const sep = (s: string) => {
        const el = document.createElement('span');
        el.className = 'keymap-join';
        el.textContent = s;
        dt.appendChild(el);
      };
      row.keys.forEach((group, gi) => {
        if (gi) sep('+');
        group.forEach((k, ki) => {
          if (ki) sep('/');
          const kbd = document.createElement('kbd');
          kbd.textContent = k;
          dt.appendChild(kbd);
        });
      });

      const dd = document.createElement('dd');
      dd.className = 'keymap-desc';
      dd.textContent = row.desc ?? '';
      dl.append(dt, dd);
    }
    group.appendChild(dl);
    body.appendChild(group);
  }

  d.appendChild(body);

  // Clicking the backdrop closes. The backdrop is the dialog element itself
  // (its ::backdrop is not an event target), so this checks that the click
  // landed outside the panel's own box rather than on any child.
  d.addEventListener('click', (e) => {
    if (e.target !== d) return;
    const r = d.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right
                && e.clientY >= r.top  && e.clientY <= r.bottom;
    if (!inside) d.close();
  });

  // The tree also acts on Escape (interaction.ts closes the exhibit panel), and
  // a <dialog> Escape must not reach it — showModal's own handling closes the
  // dialog, so this only has to stop the propagation.
  d.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') e.stopPropagation();
  });

  return d;
}

export function keymapOpen(): void {
  if (!dialog) {
    dialog = build();
    document.body.appendChild(dialog);
  }
  dialog.showModal();
}

// ── The ? shortcut ───────────────────────────────────────────────────────────
// Claimed window-level, the way search claims Ctrl+F (see search.ts). '?' is a
// shifted key on most layouts, so this matches the *character* produced rather
// than the physical key — e.key is already layout-resolved, and matching '/'
// plus shiftKey would be wrong everywhere '?' sits elsewhere.

// Anything that takes typed text must keep it: a '?' typed into the search box
// or any other field is a character, not a command.
function isTyping(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

// A node in "mode" has focus inside its own content rather than on the row —
// the same condition the per-handler FocusGating tracks as modeActive (see
// wireFocusGating in handler-utils.ts). That state belongs to the focused
// handler and is not reachable from here, but it is defined entirely by where
// focus sits, so it is read from the DOM instead of plumbed through.
function inNodeMode(el: Element | null): boolean {
  const content = el?.closest?.('.node-content');
  return !!content && el !== content;
}

export function keymapInstallShortcut(): void {
  window.addEventListener('keydown', (e) => {
    if (e.key !== '?') return;
    if (e.defaultPrevented) return;
    // Modifier-held '?' belongs to the browser or the OS, not to us.
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const active = document.activeElement;
    if (isTyping(active)) return;
    if (inNodeMode(active)) return;
    // Already open: let the dialog's own Escape handling be the way out, so a
    // second '?' is not a toggle that could close a panel mid-read.
    if (dialog?.open) return;
    e.preventDefault();
    keymapOpen();
  });
}
