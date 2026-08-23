/**
 * markdown.ts
 *
 * Renders a multiline Markdown body inside a node.
 * Body lines are collected by the parser from a following fenced code block.
 *
 * Supports the full CommonMark spec via marked.js, plus:
 *   - GFM tables
 *   - KaTeX math: $inline$ and $$display$$ (runtime; degrades to <pre> at build time)
 *
 * Exports:
 *   mdToHtml(text)        — runtime block markdown → HTML string
 *   staticMdToHtml(text)  — build-time block markdown → HTML string (no DOM, no KaTeX)
 *   mdInline(text)        — runtime inline markdown → HTML string
 *   staticMdInline(text)  — build-time inline markdown → HTML string
 */

import { splitSegments, STATE_EVENT_ATTRS } from '../shared/parser.js';
import { Multimap } from '../shared/multimap.js';
import { KATEX_DEADLINE_MS } from './constants.js';

// marked is loaded as a classic <script> before this module at runtime, and
// provided as a CJS import in the build. Access via globalThis so this file
// works in both contexts without a hard static import.
declare const DOMPurify: { sanitize(html: string, config?: Record<string, unknown>): string };
declare const katex: { renderToString(src: string, opts: Record<string, unknown>): string } | undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const marked = (globalThis as any).marked as {
  Marked: new () => {
    use(opts: Record<string, unknown>): void;
    parse(src: string): string;
    parseInline(src: string): string;
  };
};

// ── Escape helper ──────────────────────────────────────────────────────────────

function mdEscHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Sanitizer ──────────────────────────────────────────────────────────────────

// Tag groups. The block and inline sanitizers differ only in whether the
// block-level tags are allowed — everything else is shared, so math/SVG support
// can't drift between the two lists (it did once: the KaTeX SVG group was added
// to the block list only, silently eating every radical in inline math).
const BLOCK_TAGS = [
  'p', 'hr', 'blockquote', 'pre', 'div',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
];

const INLINE_TAGS = [
  'a', 'strong', 'em', 'b', 'i', 'code', 'del', 's', 'sup', 'sub',
  'span', 'img', 'ruby', 'rt', 'rp', 'br',
];

const MATH_TAGS = [
  // KaTeX / MathML
  'math', 'mrow', 'mi', 'mo', 'mn', 'msup', 'msub', 'msubsup',
  'mfrac', 'msqrt', 'mroot', 'mtext', 'mspace', 'mover', 'munder',
  'munderover', 'mtable', 'mtr', 'mtd', 'mpadded', 'mphantom',
  'mstyle', 'semantics', 'annotation',
  // KaTeX SVG (radical sign, extensible arrows, etc.)
  'svg', 'path', 'line', 'rect', 'circle', 'g',
];

const SANITIZE_TAGS = [...BLOCK_TAGS, ...INLINE_TAGS, ...MATH_TAGS];

const SANITIZE_ATTRS = [
  'href', 'src', 'alt', 'title', 'class', 'id', 'draggable', 'loading',
  'colspan', 'rowspan', 'align',
  'target', 'rel',
  // MathML
  'mathvariant', 'mathsize', 'displaystyle', 'stretchy',
  'lspace', 'rspace', 'scriptlevel',
  // aria
  'aria-hidden', 'aria-selected', 'aria-label',
  'role', 'tabindex',
  // MathML annotation
  'encoding',
  // KaTeX SVG attributes
  'viewBox', 'preserveAspectRatio', 'd', 'width', 'height', 'x', 'y',
  'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r',
];

// KaTeX uses inline style for layout. Allow only numeric/unit CSS properties
// that KaTeX actually needs; strip anything that could be used for UI spoofing
// (position, display, z-index, background, etc.).
const SAFE_STYLE_PROPS = /^(height|width|min-width|max-width|vertical-align|top|bottom|left|right|padding(-left|-right|-top|-bottom)?|margin(-left|-right|-top|-bottom)?)$/;
const SAFE_STYLE_VALUE = /^-?[\d.]+(em|ex|px|rem|%|pt)?$/;

function sanitizeStyleAttr(value: string): string {
  return value.split(';')
    .map(decl => {
      const [prop, ...rest] = decl.split(':');
      if (!prop) return null;
      const p = prop.trim().toLowerCase();
      const v = rest.join(':').trim();
      if (SAFE_STYLE_PROPS.test(p) && SAFE_STYLE_VALUE.test(v)) return `${p}:${v}`;
      return null;
    })
    .filter(Boolean)
    .join(';');
}

function makeSanitizeConfig(tags: string[], attrs: string[]): Record<string, unknown> {
  return {
    ALLOWED_TAGS: tags,
    ALLOWED_ATTR: [...attrs, 'style'],
    ALLOW_DATA_ATTR: true,
    FORBID_ATTR: [],
    BEFORE_SANITIZE_ATTRS(node: Element) {
      if (node.hasAttribute?.('style')) {
        const clean = sanitizeStyleAttr(node.getAttribute('style')!);
        if (clean) node.setAttribute('style', clean);
        else node.removeAttribute('style');
      }
    },
  };
}

export function sanitizeMd(html: string): string {
  return DOMPurify.sanitize(html, makeSanitizeConfig(SANITIZE_TAGS, SANITIZE_ATTRS));
}

// Same as SANITIZE_TAGS minus BLOCK_TAGS: parseInline() output lands inside an
// existing element, so a block tag there could break out of its container.
const SANITIZE_INLINE_TAGS = [...INLINE_TAGS, ...MATH_TAGS];

function sanitizeMdInline(html: string): string {
  return DOMPurify.sanitize(html, makeSanitizeConfig(SANITIZE_INLINE_TAGS, SANITIZE_ATTRS));
}

// ── Math extensions ────────────────────────────────────────────────────────────

const mathBlockExtension = {
  name: 'mathBlock',
  level: 'block' as const,
  start(src: string) { return src.indexOf('$$'); },
  tokenizer(src: string) {
    const m = src.match(/^\$\$\n([\s\S]*?)\n\$\$/);
    if (m) return { type: 'mathBlock', raw: m[0], math: m[1] };
  },
  // renderer is overridden per-instance below
};

const mathInlineExtension = {
  name: 'mathInline',
  level: 'inline' as const,
  start(src: string) { return src.indexOf('$'); },
  tokenizer(src: string) {
    const d = src.match(/^\$\$([^$]+)\$\$/);
    if (d) return { type: 'mathInline', raw: d[0], math: d[1], display: true };
    const i = src.match(/^\$([^$\n]+)\$/);
    if (i) return { type: 'mathInline', raw: i[0], math: i[1], display: false };
  },
  // renderer is overridden per-instance below
};

// ── Per-parse span map ─────────────────────────────────────────────────────────
// walkTokens populates this during each parse call; callers read it immediately after.

let _currentSpanMap: Map<number, ParsedSpanAttrs> | null = null;
let _spanOrdinalWalk = 0;

/**
 * How a span's `img:` ref becomes a URL, for the duration of one parse.
 *
 * Synchronous, because marked's renderers are synchronous by contract: a
 * promise returned from a renderer is concatenated as `[object Promise]`.
 * A caller that must reach the origin resolves its refs BEFORE parsing and
 * passes the answers in — see `mdInlineWithSpansResolved`. Awaiting inside the
 * parse instead is what made two labels rendering in the same tick clobber
 * each other's span map.
 *
 * Null in a parse that does not resolve, where the ref renders as authored.
 */
let _urlResolver: ((url: string) => string | null) | null = null;

// ── Factory: build a configured Marked instance ────────────────────────────────

interface MarkedOpts {
  renderMathBlock: (src: string) => string;
  renderMathInline: (src: string, display: boolean) => string;
}

function makeMarked(opts: MarkedOpts) {
  const {
    renderMathBlock,
    renderMathInline,
  } = opts;

  const instance = new marked.Marked();

  instance.use({
    gfm: true,
    extensions: [
      Object.assign({}, mathBlockExtension, {
        renderer(token: { math: string }) { return renderMathBlock(token.math); },
      }),
      Object.assign({}, mathInlineExtension, {
        renderer(token: { math: string; display: boolean }) { return renderMathInline(token.math, token.display); },
      }),
      rvmarkSpanExtension,
    ],
    walkTokens(token: any) {
      if (token.type !== 'rvmarkSpan' || !_currentSpanMap) return;
      const attrs = parseInlineSpanParams(token.rawParams);
      const rawIndex = attrs.get('index');
      let ordinal: number;
      if (rawIndex !== undefined && rawIndex !== '' && Number.isFinite(parseInt(rawIndex, 10))) {
        ordinal = parseInt(rawIndex, 10);
        if (ordinal > _spanOrdinalWalk) _spanOrdinalWalk = ordinal;
      } else {
        _spanOrdinalWalk++;
        ordinal = _spanOrdinalWalk;
      }
      token._rvmarkOrdinal = ordinal;
      _currentSpanMap.set(ordinal, attrs);
    },
    renderer: {
      link({ href, tokens }: { href: string | null; tokens: unknown[] }) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const text = (this as any).parser.parseInline(tokens);
        if (!href) return text;
        if (href.startsWith('#')) {
          return `<a href="${mdEscHtml(href)}">${text}</a>`;
        }
        const proto = (href.match(/^([a-zA-Z][a-zA-Z0-9+\-.]*):/) ?? [])[1]?.toLowerCase();
        if (proto && !['http', 'https', 'mailto'].includes(proto)) return text;
        return `<a href="${mdEscHtml(href)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
      },
    },
  });

  return instance;
}

// ── Inline span extension: [text]{key: val; ...} ──────────────────────────────

/**
 * A span's attribute block, parsed to the same Multimap every other rvmark attr
 * collection uses (see multimap.ts). Keys are canonical: the `=>` sigil
 * normalizes to `transclude` and a bare `let`/`set`/`remove` to `on-action`,
 * mirroring parseAttrBlock's sigil handling.
 *
 * Consumers ask `.has(k)` for flags and `.getAll(k)` for repeatable keys —
 * notably the `on-*` chains, where the previous one-field-per-key shape silently
 * dropped all but the last handler.
 */
export type ParsedSpanAttrs = Multimap;

// Bare `let`/`set`/`remove` on a span defaults to on-action: the mutation fires
// when the span is activated. (On a node, a bare `let` means on-spawn instead —
// a span has no spawn of its own, so there is nothing for it to hook.)
//
// An OPTION span re-files these to on-select once node attrs settle the span's
// kind — see retargetBareMutations in span-toggle.ts. The bare form is recorded
// under BARE_MUTATION_KEY so that pass can tell it from an explicitly written
// `on-action:`, which always means the action gesture and is never re-filed.
export const BARE_MUTATION_KEY = 'rvmark-bare-mutation';

// The span kinds that handle their own clicks and carry their own focus. Kept
// here, beside the code that stamps the classes, so the set has one definition:
// callers ask spanIsInteractive rather than re-writing the selector, and a new
// interactive kind is added in one place instead of found by grep.
export const INTERACTIVE_SPAN_CLASSES = {
  toggle: 'inline-toggle',
  option: 'inline-option',
} as const;

export const INTERACTIVE_SPAN_SELECTOR =
  Object.values(INTERACTIVE_SPAN_CLASSES).map(c => `.${c}`).join(', ');

/** True when `el` is, or sits inside, a span that owns its own click gesture.
 *  Node-level wiring uses this to keep its hands off: focus-stealing or
 *  default-suppression on the node's behalf must never reach such a span. */
export function spanIsInteractive(el: HTMLElement | null): boolean {
  return !!el?.closest(INTERACTIVE_SPAN_SELECTOR);
}

export function parseInlineSpanParams(raw: string): ParsedSpanAttrs {
  const out = new Multimap();
  for (const part of splitSegments(raw)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('=>')) { out.append('transclude', trimmed.slice(2).trim()); continue; }
    if (/^(let|set|remove)\b/.test(trimmed)) {
      out.append('on-action', trimmed);
      out.append(BARE_MUTATION_KEY, trimmed);
      continue;
    }
    const colon = trimmed.indexOf(':');
    if (colon === -1) out.append(trimmed, '');
    else out.append(trimmed.slice(0, colon).trim(), trimmed.slice(colon + 1).trim());
  }
  return out;
}

// The keys renderInlineSpan consumes itself; everything else becomes a data-*
// attribute. Listed here so a new behavioural key is added in one place.
//
// Built on first use, not at module scope: parser.ts reaches this module through
// inherited.ts → tags.ts, so STATE_EVENT_ATTRS is still uninitialized while this
// module is evaluating.
let _spanReserved: Set<string> | null = null;
function spanReserved(): Set<string> {
  return _spanReserved ??= new Set([
    'option', 'selected', 'index', 'transclude', 'href', 'img', 'ruby',
    'class', 'style', 'role', 'show-when', 'toggle',
    ...STATE_EVENT_ATTRS,
  ]);
}

function renderInlineSpan(token: any, label: string): string {
  const attrs        = parseInlineSpanParams(token.rawParams);
  const ordinal: number = token._rvmarkOrdinal ?? 0;
  const classes: string[]   = [];
  const dataAttrs: string[] = [`data-rvmark-span="${ordinal}"`];
  const directAttrs: string[] = [];

  let role:  string | null = attrs.get('role')  ?? null;
  const style: string | null = attrs.get('style') ?? null;

  // Role is settled here only for spans whose kind their own attrs determine.
  // A bare `=> #ref` is a manual toggle, but node-level `{listbox}` may make it
  // an option — which this renderer cannot see — so the handler restamps
  // role/marker once node attrs are known.
  // See listbox-utils.spanIsSelectionDriven and the design note §1c.
  if (attrs.has('option') || attrs.has('on-action')) {
    classes.push(INTERACTIVE_SPAN_CLASSES.option);
    role = 'option';
  } else if (attrs.has('transclude') || attrs.has('toggle')) {
    classes.push(INTERACTIVE_SPAN_CLASSES.toggle);
    // aria-expanded is added at wiring time — a span the node turns into an
    // option must not carry a disclosure role.
  }

  // A conditional span starts hidden and is revealed by wireSpanVisibility once
  // it has a state frame to read. Hiding here rather than after wiring is what
  // keeps a span that starts false from flashing on first paint; a span with no
  // live state (static build, sidepanel preview) simply stays hidden, matching how
  // an unmounted show-when node renders as absent.
  if (attrs.has('show-when')) classes.push('span-conditional-pending');
  for (const c of attrs.getAll('class')) classes.push(...c.split(/\s+/).filter(Boolean));

  const reserved = spanReserved();
  for (const [k, v] of attrs.allEntries()) {
    if (reserved.has(k)) continue;
    if (k.startsWith('.')) {
      classes.push(k.slice(1));
    } else if (k === 'tabindex' || k.startsWith('aria-')) {
      directAttrs.push(`${mdEscHtml(k)}="${mdEscHtml(v)}"`);
    } else {
      dataAttrs.push(`data-${mdEscHtml(k)}="${mdEscHtml(v)}"`);
    }
  }

  const cls       = classes.length     ? ` class="${classes.map(mdEscHtml).join(' ')}"` : '';
  const roleAt    = role               ? ` role="${mdEscHtml(role)}"` : '';
  const styleAt   = style              ? ` style="${mdEscHtml(style)}"` : '';
  const directStr = directAttrs.length ? ' ' + directAttrs.join(' ')  : '';
  const dataStr   = dataAttrs.length   ? ' ' + dataAttrs.join(' ')    : '';

  const img    = attrs.get('img');
  // Falls back to the authored ref when nothing resolved it (a parse with no
  // resolver, or an origin that will not serve it), which is what it rendered
  // as before it resolved at all.
  const imgSrc = img ? (_urlResolver?.(img) ?? img) : null;
  let content = imgSrc
    ? `<img src="${mdEscHtml(imgSrc)}" alt="${mdEscHtml(label)}" loading="lazy" draggable="false">`
    : label;
  const ruby = attrs.get('ruby');
  if (ruby) {
    content = `<ruby>${content}<rt>${mdEscHtml(ruby)}</rt></ruby>`;
  }

  const href = attrs.get('href');
  if (href) {
    const hrefAt = ` href="${mdEscHtml(href)}"`;
    return `<a${hrefAt} target="_blank" rel="noopener noreferrer"${roleAt}${cls}${styleAt}${directStr}${dataStr}>${content}</a>`;
  }
  return `<span${roleAt}${cls}${styleAt}${directStr}${dataStr}>${content}</span>`;
}

const rvmarkSpanExtension = {
  name: 'rvmarkSpan',
  level: 'inline' as const,
  start(src: string) { return src.indexOf('['); },
  tokenizer(this: any, src: string) {
    const m = src.match(/^\[((?:[^\]\\]|\\[\s\S])*)\]\{([^}]*)\}/);
    if (m) {
      const token: any = { type: 'rvmarkSpan', raw: m[0], rawParams: m[2], tokens: [] };
      token.tokens = this.lexer.inlineTokens(m[1]);
      return token;
    }
  },
  renderer(this: any, token: { tokens: unknown[]; rawParams: string }) {
    return renderInlineSpan(token, (this as any).parser.parseInline(token.tokens));
  },
};

// ── Math fallbacks (no KaTeX) ──────────────────────────────────────────────────

function mathBlockFallback(src: string): string         { return `<pre class="md-math-block">${mdEscHtml(src)}</pre>`; }
function mathInlineFallback(src: string, display: boolean): string {
  return display ? mathBlockFallback(src) : `<code>${mdEscHtml(src)}</code>`;
}

// ── Lazy KaTeX ─────────────────────────────────────────────────────────────────
//
// KaTeX is ~280KB of JS + CSS and most pages have no math, so it is not in the
// page template — it is fetched the first time a math token is actually parsed.
//
// Rendering is synchronous (katex.renderToString returns HTML inline), so the
// script must be present BEFORE the markdown that needs it renders. Callers
// therefore await ensureKatex() first. Block nodes declare `managesReady`, so
// the node simply does not mount until this resolves — and the MOUNT_SETTLE_MS
// race means a fast CDN response never shows a placeholder at all. Nothing ever
// paints in fallback form and then upgrades, so there is no flash.
//
// The fallbacks above remain the path for the build (no DOM, no network) and for
// a failed load.

const KATEX_VERSION = '0.16.11';
const KATEX_BASE    = `https://cdn.jsdelivr.net/npm/katex@${KATEX_VERSION}/dist/katex.min`;

let _katexPromise: Promise<void> | null = null;

/** True once KaTeX is on the page — lets callers skip the await entirely. */
export function katexLoaded(): boolean {
  return typeof katex !== 'undefined';
}

/** Does this source contain anything the math tokenizers would pick up? */
export function hasMath(src: string): boolean {
  return src.includes('$');
}

/**
 * Rendered markup, prepared for the clipboard.
 *
 * KaTeX renders each formula twice — a .katex-mathml branch (MathML, plus the
 * original TeX in an <annotation>) for assistive tech, and a .katex-html branch
 * for sighted readers — and hides the former with CSS. The clipboard carries
 * markup without our stylesheet, so the paste target renders every branch and
 * the formula arrives three times over. Dropping the MathML leaves the visual
 * rendering alone.
 */
export function clipboardHtml(el: HTMLElement): string {
  if (!el.querySelector('.katex-mathml')) return el.innerHTML;
  const clone = el.cloneNode(true) as HTMLElement;
  for (const m of clone.querySelectorAll('.katex-mathml')) m.remove();
  return clone.innerHTML;
}

/**
 * Load KaTeX once, resolving when it is usable. Resolves immediately if already
 * present. NEVER rejects and never hangs: on error or timeout it resolves anyway,
 * and math then renders through the fallbacks above.
 *
 * The deadline is load-bearing. Callers defer mounting a node until this settles,
 * so a request that neither loads nor errors — an offline reader, a blocked CDN
 * that black-holes rather than refusing — would otherwise leave that content
 * permanently invisible. Bounding the wait means the worst case is unstyled math,
 * never missing content. Same reasoning as TRANSCLUDE_DEADLINE_MS.
 */
export function ensureKatex(): Promise<void> {
  if (katexLoaded()) return Promise.resolve();
  if (_katexPromise) return _katexPromise;
  if (typeof document === 'undefined') return Promise.resolve(); // build-time

  _katexPromise = new Promise<void>(resolve => {
    let settled = false;
    const done = (warn?: string) => {
      if (settled) return;
      settled = true;
      if (warn) console.warn(`rvmark: ${warn}; math renders unstyled`);
      resolve();
    };

    const css = document.createElement('link');
    css.rel  = 'stylesheet';
    css.href = `${KATEX_BASE}.css`;
    document.head.appendChild(css);

    const js = document.createElement('script');
    js.src = `${KATEX_BASE}.js`;
    js.onload  = () => done();
    js.onerror = () => done('KaTeX failed to load');
    document.head.appendChild(js);

    setTimeout(() => done('KaTeX timed out'), KATEX_DEADLINE_MS);
  });
  return _katexPromise;
}

// ── Lazy singleton instances ───────────────────────────────────────────────────

let _staticMarked: ReturnType<typeof makeMarked> | null = null;
function getStaticMarked() {
  if (!_staticMarked) {
    _staticMarked = makeMarked({
      renderMathBlock:  mathBlockFallback,
      renderMathInline: mathInlineFallback,
    });
  }
  return _staticMarked;
}

let _runtimeMarked: ReturnType<typeof makeMarked> | null = null;
function getRuntimeMarked() {
  if (!_runtimeMarked) {
    _runtimeMarked = makeMarked({
      renderMathBlock(src: string) {
        if (typeof katex !== 'undefined')
          return `<p class="md-math-block">${katex.renderToString(src, { displayMode: true, throwOnError: false })}</p>`;
        return mathBlockFallback(src);
      },
      renderMathInline(src: string, display: boolean) {
        if (typeof katex !== 'undefined')
          return katex.renderToString(src, { displayMode: display, throwOnError: false });
        return mathInlineFallback(src, display);
      },
    });
  }
  return _runtimeMarked;
}

// ── Public API ─────────────────────────────────────────────────────────────────

function withSpanMap<T>(
  fn: () => T,
  startOrdinal = 0,
  resolveUrl: ((url: string) => string | null) | null = null,
): { result: T; spanMap: Map<number, ParsedSpanAttrs>; endOrdinal: number } {
  const spanMap = new Map<number, ParsedSpanAttrs>();
  _currentSpanMap  = spanMap;
  _spanOrdinalWalk = startOrdinal;
  _urlResolver     = resolveUrl;
  try {
    const result = fn();
    return { result, spanMap, endOrdinal: _spanOrdinalWalk };
  } finally {
    _currentSpanMap = null;
    _urlResolver    = null;
  }
}

export function mdToHtml(text: string): string {
  return withSpanMap(() => sanitizeMd(getRuntimeMarked().parse(text))).result;
}

export function mdToHtmlWithSpans(text: string): { html: string; spanMap: Map<number, ParsedSpanAttrs> } {
  const { result, spanMap } = withSpanMap(() => sanitizeMd(getRuntimeMarked().parse(text)));
  return { html: result, spanMap };
}

export function staticMdToHtml(text: string): string {
  return withSpanMap(() => getStaticMarked().parse(text)).result;
}

export function mdInline(text: string): string {
  return withSpanMap(() =>
    sanitizeMdInline(getRuntimeMarked().parseInline(text))).result;
}

export function mdInlineWithSpans(
  text: string,
): { html: string; spanMap: Map<number, ParsedSpanAttrs> } {
  const { result, spanMap } = withSpanMap(
    () => sanitizeMdInline(getRuntimeMarked().parseInline(text) as string),
  );
  return { html: result, spanMap };
}

/**
 * The span attrs whose value is a resource ref rather than a literal — the
 * things an origin resolves. One list, because a parse that resolves refs and
 * a caller that collects them must agree on what a ref is; adding a kind is
 * adding a line here.
 */
export const SPAN_RESOURCE_KEYS = ['img'] as const;

/** Every resource ref the spans of one parse carry, deduplicated. */
export function collectSpanResourceRefs(spanMap: Map<number, ParsedSpanAttrs>): string[] {
  const refs = new Set<string>();
  for (const attrs of spanMap.values()) {
    for (const key of SPAN_RESOURCE_KEYS) {
      for (const v of attrs.getAll(key)) if (v) refs.add(v);
    }
  }
  return [...refs];
}

/**
 * `mdInlineWithSpans` for a label whose resource refs should resolve.
 *
 * Two synchronous parses with the asking in between, rather than one parse that
 * awaits: marked's renderers are synchronous by contract, and the parser's
 * module state cannot survive an await — two labels rendering in the same tick
 * would clobber each other's span map, which is what ordinal 0 on every span
 * meant. The two passes cannot disagree about what to resolve: a ref is an
 * opaque string in a span's attrs, and what comes back only ever lands in an
 * attribute of the emitted element, never in what gets tokenized.
 *
 * `resolveRefs` takes the label's refs together and answers positionally — one
 * query for the label, not one per ref. A ref it answers `null` for stays as
 * authored and fails like any dead URL in HTML, per ref, so one dead ref does
 * not unresolve its neighbours.
 */
export async function mdInlineWithSpansResolved(
  text: string,
  resolveRefs: (refs: string[]) => Promise<(string | null)[]>,
): Promise<{ html: string; spanMap: Map<number, ParsedSpanAttrs> }> {
  const refs = collectSpanResourceRefs(mdInlineWithSpans(text).spanMap);
  let answers: (string | null)[];
  try { answers = await resolveRefs(refs); }
  catch { answers = refs.map(() => null); }
  return mdInlineWithSpansUsing(text, new Map(refs.map((ref, i) => [ref, answers[i] ?? null])));
}

/** The resolved half of the pair, for a caller that already holds the answers. */
export function mdInlineWithSpansUsing(
  text: string,
  resolved: Map<string, string | null>,
): { html: string; spanMap: Map<number, ParsedSpanAttrs> } {
  const { result, spanMap } = withSpanMap(
    () => sanitizeMdInline(getRuntimeMarked().parseInline(text)),
    0,
    (url) => resolved.get(url) ?? null,
  );
  return { html: result, spanMap };
}

// Like mdInlineWithSpans but continues ordinal numbering from a previous call.
// Returns the next startOrdinal to pass to subsequent calls, and merges into the
// provided spanMap in place.
export function mdInlineWithSpansContinued(
  text: string,
  spanMap: Map<number, ParsedSpanAttrs>,
  startOrdinal: number,
): { html: string; nextOrdinal: number } {
  const { result, spanMap: partial, endOrdinal } = withSpanMap(
    () => sanitizeMdInline(getRuntimeMarked().parseInline(text) as string),
    startOrdinal,
  );
  for (const [k, v] of partial) spanMap.set(k, v);
  return { html: result, nextOrdinal: endOrdinal };
}

/**
 * `staticMdInline` for the builder, which resolves synchronously: it is the
 * origin's Node-side half, with the store in hand and no wire between them.
 * Same two-pass shape as the client's, minus the awaiting.
 */
export function staticMdInlineResolved(
  text: string,
  resolveRefs: (refs: string[]) => (string | null)[],
): string {
  const refs = collectSpanResourceRefs(staticMdInlineWithSpans(text).spanMap);
  const answers = resolveRefs(refs);
  const resolved = new Map(refs.map((ref, i) => [ref, answers[i] ?? null] as const));
  return withSpanMap(
    () => getStaticMarked().parseInline(text),
    0,
    (url) => resolved.get(url) ?? null,
  ).result;
}

function staticMdInlineWithSpans(text: string): { spanMap: Map<number, ParsedSpanAttrs> } {
  return withSpanMap(() => getStaticMarked().parseInline(text));
}

export function staticMdInline(text: string): string {
  return withSpanMap(() =>
    getStaticMarked().parseInline(text)).result;
}
