/**
 * markdown.ts
 *
 * Renders a multiline Markdown body inside a node.
 * Body lines are collected by the parser (collectsBody: true).
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
 *   setExtIconSvg(svg)    — called by renderer.ts to inject the external link icon
 */

import { parseOnSpawn } from './parser.js';
import type { StateEntry } from './parser.js';

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

const SANITIZE_TAGS = [
  // Block
  'p', 'br', 'hr', 'blockquote', 'pre', 'div',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
  // Inline
  'a', 'strong', 'em', 'b', 'i', 'code', 'del', 's', 'sup', 'sub',
  'span', 'img', 'ruby', 'rt', 'rp',
  // KaTeX / MathML
  'math', 'mrow', 'mi', 'mo', 'mn', 'msup', 'msub', 'msubsup',
  'mfrac', 'msqrt', 'mroot', 'mtext', 'mspace', 'mover', 'munder',
  'munderover', 'mtable', 'mtr', 'mtd', 'mpadded', 'mphantom',
  'semantics', 'annotation',
  // KaTeX SVG (radical sign, extensible arrows, etc.)
  'svg', 'path', 'line', 'rect', 'circle', 'g',
];

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

const SANITIZE_INLINE_TAGS = [
  'a', 'strong', 'em', 'b', 'i', 'code', 'del', 's', 'sup', 'sub', 'span', 'br', 'img', 'ruby', 'rt', 'rp',
  // KaTeX / MathML
  'math', 'mrow', 'mi', 'mo', 'mn', 'msup', 'msub', 'msubsup',
  'mfrac', 'msqrt', 'mroot', 'mtext', 'mspace', 'mover', 'munder',
  'munderover', 'mtable', 'mtr', 'mtd', 'mpadded', 'mphantom',
  'semantics', 'annotation',
];

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
let _currentUrlResolver: ((url: string) => string | null) | null = null;

// ── Factory: build a configured Marked instance ────────────────────────────────

interface MarkedOpts {
  renderMathBlock: (src: string) => string;
  renderMathInline: (src: string, display: boolean) => string;
  extLinkSuffix?: string;
}

function makeMarked(opts: MarkedOpts) {
  const {
    renderMathBlock,
    renderMathInline,
    extLinkSuffix = '',
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
      let ordinal: number;
      if (attrs.index !== undefined) {
        ordinal = attrs.index;
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
        return `<a href="${mdEscHtml(href)}" target="_blank" rel="noopener noreferrer">${text}${extLinkSuffix}</a>`;
      },
    },
  });

  return instance;
}

// ── Inline span extension: [text]{key: val; ...} ──────────────────────────────

export interface ParsedSpanAttrs {
  option?:           true;
  selected?:         true;
  index?:            number;
  transclude?:       string;   // raw ref string, e.g. './path#slug'
  stateAssignments?: StateEntry[];
  'on-select'?:      string;
  'on-deselect'?:    string;
  'on-focus'?:       string;
  'on-blur'?:        string;
  'on-action'?:      string;
  href?:             string;
  img?:              string;
  ruby?:             string;
  class?:            string;
  style?:            string;
  role?:             string;
  extra:             Record<string, string | true>;  // everything else
}

export function parseInlineSpanParams(raw: string): ParsedSpanAttrs {
  const result: ParsedSpanAttrs = { extra: {} };
  for (const part of raw.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    // '=>' transclusion ref — rest of token is the ref value
    if (trimmed.startsWith('=>')) {
      result.transclude = trimmed.slice(2).trim();
      continue;
    }
    // '&...' or '!&...' state assignment — same grammar as node-level on-spawn/on-select
    if (trimmed.startsWith('&') || trimmed.startsWith('!&')) {
      const entries = parseOnSpawn(trimmed);
      if (entries.length) {
        if (!result.stateAssignments) result.stateAssignments = [];
        result.stateAssignments.push(...entries);
      }
      continue;
    }
    const colon = trimmed.indexOf(':');
    if (colon === -1) {
      if (trimmed === 'option')   result.option   = true;
      else if (trimmed === 'selected') result.selected = true;
      else result.extra[trimmed] = true;
    } else {
      const k = trimmed.slice(0, colon).trim();
      const v = trimmed.slice(colon + 1).trim();
      if (k === 'option')       { result.option = true; }
      else if (k === 'index')    { result.index = parseInt(v, 10); }
      else if (k === 'href')     { result.href  = v; }
      else if (k === 'img')      { result.img   = v; }
      else if (k === 'ruby')     { result.ruby  = v; }
      else if (k === 'class')    { result.class = v; }
      else if (k === 'style')    { result.style = v; }
      else if (k === 'role')     { result.role  = v; }
      else if (k === 'on-select' || k === 'on-deselect' || k === 'on-focus' || k === 'on-blur' || k === 'on-action')
        result[k] = v;
      else result.extra[k] = v;
    }
  }
  return result;
}

function renderInlineSpan(token: any, label: string): string {
  const attrs        = parseInlineSpanParams(token.rawParams);
  const ordinal: number = token._rvmarkOrdinal ?? 0;
  const classes: string[]   = [];
  const dataAttrs: string[] = [`data-rvmark-span="${ordinal}"`];
  const directAttrs: string[] = [];

  let role:  string | null = attrs.role  ?? null;
  let style: string | null = attrs.style ?? null;

  if (attrs.option || attrs.stateAssignments?.length || attrs.transclude) {
    classes.push('inline-option');
    role = 'option';
  }
  if (attrs.class) classes.push(...attrs.class.split(/\s+/).filter(Boolean));

  for (const [k, v] of Object.entries(attrs.extra)) {
    if (k.startsWith('.')) {
      classes.push(k.slice(1));
    } else if (k === 'tabindex' || k.startsWith('aria-')) {
      directAttrs.push(`${mdEscHtml(k)}="${mdEscHtml(String(v))}"`);
    } else {
      dataAttrs.push(`data-${mdEscHtml(k)}="${mdEscHtml(String(v))}"`);
    }
  }

  const cls       = classes.length     ? ` class="${classes.map(mdEscHtml).join(' ')}"` : '';
  const roleAt    = role               ? ` role="${mdEscHtml(role)}"` : '';
  const styleAt   = style              ? ` style="${mdEscHtml(style)}"` : '';
  const directStr = directAttrs.length ? ' ' + directAttrs.join(' ')  : '';
  const dataStr   = dataAttrs.length   ? ' ' + dataAttrs.join(' ')    : '';

  const imgSrc = attrs.img
    ? (_currentUrlResolver?.(attrs.img) ?? attrs.img)
    : null;
  let content = imgSrc
    ? `<img src="${mdEscHtml(imgSrc)}" alt="${mdEscHtml(label)}" loading="lazy" draggable="false">`
    : label;
  if (attrs.ruby) {
    content = `<ruby>${content}<rt>${mdEscHtml(attrs.ruby)}</rt></ruby>`;
  }

  if (attrs.href) {
    const hrefAt = ` href="${mdEscHtml(attrs.href)}"`;
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

// ── External link icon ─────────────────────────────────────────────────────────

let _extIconSvg = '';
export function setExtIconSvg(svg: string): void { _extIconSvg = svg; _runtimeMarked = null; }

// ── Math fallbacks (no KaTeX) ──────────────────────────────────────────────────

function mathBlockFallback(src: string): string         { return `<pre class="md-math-block">${mdEscHtml(src)}</pre>`; }
function mathInlineFallback(src: string, display: boolean): string {
  return display ? mathBlockFallback(src) : `<code>${mdEscHtml(src)}</code>`;
}

// ── Lazy singleton instances ───────────────────────────────────────────────────

let _staticMarked: ReturnType<typeof makeMarked> | null = null;
function getStaticMarked() {
  if (!_staticMarked) {
    _staticMarked = makeMarked({
      renderMathBlock:  mathBlockFallback,
      renderMathInline: mathInlineFallback,
      extLinkSuffix: '',
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
      extLinkSuffix: _extIconSvg,
    });
  }
  return _runtimeMarked;
}

// ── Public API ─────────────────────────────────────────────────────────────────

function withSpanMap<T>(
  fn: () => T,
  resolveUrl?: (url: string) => string | null,
  startOrdinal = 0,
): { result: T; spanMap: Map<number, ParsedSpanAttrs>; endOrdinal: number } {
  const spanMap = new Map<number, ParsedSpanAttrs>();
  _currentSpanMap     = spanMap;
  _spanOrdinalWalk    = startOrdinal;
  _currentUrlResolver = resolveUrl ?? null;
  const result = fn();
  const endOrdinal = _spanOrdinalWalk;
  _currentSpanMap     = null;
  _currentUrlResolver = null;
  return { result, spanMap, endOrdinal };
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
    sanitizeMdInline(text.split(/  \n/).map(s => getRuntimeMarked().parseInline(s)).join('<br>'))).result;
}

export function mdInlineWithSpans(
  text: string,
  resolveUrl?: (url: string) => string | null,
): { html: string; spanMap: Map<number, ParsedSpanAttrs> } {
  const { result, spanMap } = withSpanMap(
    () => sanitizeMdInline(text.split(/  \n/).map(s => getRuntimeMarked().parseInline(s)).join('<br>')),
    resolveUrl,
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
  resolveUrl?: (url: string) => string | null,
): { html: string; nextOrdinal: number } {
  const { result, spanMap: partial, endOrdinal } = withSpanMap(
    () => sanitizeMdInline(text.split(/  \n/).map(s => getRuntimeMarked().parseInline(s)).join('<br>')),
    resolveUrl,
    startOrdinal,
  );
  for (const [k, v] of partial) spanMap.set(k, v);
  return { html: result, nextOrdinal: endOrdinal };
}

export function staticMdInline(text: string): string {
  return withSpanMap(() =>
    text.split(/  \n/).map(s => getStaticMarked().parseInline(s)).join('<br>')).result;
}
