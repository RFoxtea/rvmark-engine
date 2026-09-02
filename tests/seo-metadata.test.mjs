/**
 * seo-metadata.test.mjs — head metadata the crawlers and unfurlers read.
 *
 * Builds a purpose-built fixture tree rather than reusing tests/rvmark: the
 * subject is inheritance DEPTH, so the fixture needs an index.rvmark chain with
 * an override partway down, which the flat fixture cannot express.
 *
 * Fixture:
 *   index.rvmark              site-url, card-img ./root.png       → own card
 *     plain.rvmark            (no header)                         → inherits root's
 *     deep/index.rvmark       (no card-img)                       → inherits root's
 *       deep/leaf.rvmark      (no header)                         → inherits root's
 *     sub/index.rvmark        card-img ./sub.png                  → own card
 *       sub/leaf.rvmark       (no header)                         → inherits sub's
 *     noindex.rvmark          robots: noindex                     → excluded
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildSite } from '../out/build/site.js';

const ORIGIN = 'https://example.test';

const FILES = {
  'index.rvmark':      `{title: Root; site-url: ${ORIGIN}; card-img: ./root.png}\n\n- Root node\n`,
  'plain.rvmark':      `- Plain node\n`,
  'noindex.rvmark':    `{title: Secret; robots: noindex}\n\n- Secret node\n`,
  'deep/index.rvmark': `{title: Deep}\n\n- Deep node\n`,
  'deep/leaf.rvmark':  `- Deep leaf\n`,
  'sub/index.rvmark':  `{title: Sub; card-img: ./sub.png}\n\n- Sub node\n`,
  'sub/leaf.rvmark':   `- Sub leaf\n`,
};

function build(files = FILES) {
  const dir = mkdtempSync(join(tmpdir(), 'rvmark-seo-'));
  const content = join(dir, 'rvmark');
  for (const [rel, src] of Object.entries(files)) {
    const path = join(content, rel);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, src);
  }
  return { dir, content, out: join(dir, 'dist') };
}

/** Build once and hand back a reader over the emitted pages. */
async function buildFixture(files) {
  const { dir, content, out } = build(files);
  await buildSite({ contentDir: content, outDir: out });
  const page = (stem) => readFileSync(join(out, stem, 'index.html'), 'utf8');
  page.root = () => readFileSync(join(out, 'index.html'), 'utf8');
  page.file = (rel) => readFileSync(join(out, rel), 'utf8');
  page.cleanup = () => rmSync(dir, { recursive: true, force: true });
  return page;
}

/** The content of one meta/link tag, or undefined when the tag is absent. */
function tagContent(html, attr, name) {
  const re = new RegExp(`<(?:meta|link) ${attr}="${name}" (?:content|href)="([^"]*)"`);
  return html.match(re)?.[1];
}

const ogImage   = (html) => tagContent(html, 'property', 'og:image');
const ogUrl     = (html) => tagContent(html, 'property', 'og:url');
const canonical = (html) => html.match(/<link rel="canonical" href="([^"]*)"/)?.[1];
const robots    = (html) => tagContent(html, 'name', 'robots');

// ── card-img inheritance ──────────────────────────────────────────────────────
//
// The whole point of the path-valued-meta machinery: meta inherits down the
// index.rvmark chain, and the merge flattens each value to a bare string, so a
// relative address must be resolved while the file that wrote it is still known.
// Resolving it later — against the page that READ it — is the bug these cover,
// and it is invisible on the root page, where both answers agree.

test('card-img on the root page resolves against the root', async () => {
  const page = await buildFixture();
  assert.equal(ogImage(page.root()), `${ORIGIN}/_rvmark/root.png`);
  page.cleanup();
});

test('an inherited card-img resolves against the file that wrote it, not the page that reads it', async () => {
  const page = await buildFixture();
  // The failure this pins: './root.png' read from plain.rvmark resolving to
  // '/_rvmark/plain/root.png' or, when resolved twice, '/_rvmark/_rvmark/root.png'.
  assert.equal(ogImage(page('plain')), `${ORIGIN}/_rvmark/root.png`);
  page.cleanup();
});

test('card-img inheritance survives two levels of nesting', async () => {
  const page = await buildFixture();
  assert.equal(ogImage(page('deep')),      `${ORIGIN}/_rvmark/root.png`);
  assert.equal(ogImage(page('deep/leaf')), `${ORIGIN}/_rvmark/root.png`);
  page.cleanup();
});

test('a nearer card-img overrides the root and resolves against its own directory', async () => {
  const page = await buildFixture();
  assert.equal(ogImage(page('sub')), `${ORIGIN}/_rvmark/sub/sub.png`);
  page.cleanup();
});

test('an overriding card-img governs its whole subtree', async () => {
  const page = await buildFixture();
  assert.equal(ogImage(page('sub/leaf')), `${ORIGIN}/_rvmark/sub/sub.png`);
  page.cleanup();
});

test('no emitted address is resolved twice', async () => {
  const page = await buildFixture();
  for (const stem of ['plain', 'deep', 'deep/leaf', 'sub', 'sub/leaf']) {
    assert.doesNotMatch(page(stem), /_rvmark\/_rvmark/, `${stem} double-resolved an address`);
  }
  page.cleanup();
});

// ── canonical and og:url ──────────────────────────────────────────────────────

test('canonical and og:url are absolute and agree', async () => {
  const page = await buildFixture();
  assert.equal(canonical(page.root()), `${ORIGIN}/`);
  assert.equal(ogUrl(page.root()),     `${ORIGIN}/`);
  assert.equal(canonical(page('deep/leaf')), `${ORIGIN}/deep/leaf/`);
  assert.equal(ogUrl(page('deep/leaf')),     `${ORIGIN}/deep/leaf/`);
  page.cleanup();
});

// ── robots ────────────────────────────────────────────────────────────────────
//
// Named values, like `open: always|never` — not presence and not a truthy
// string. The default is ON, so a bare {robots} could only mean "index", which
// is what omitting it already means.

test('a page is indexable by default', async () => {
  const page = await buildFixture();
  assert.equal(robots(page('plain')), undefined);
  page.cleanup();
});

test('robots: noindex emits the noindex tag', async () => {
  const page = await buildFixture();
  assert.equal(robots(page('noindex')), 'noindex, follow');
  page.cleanup();
});

test('an unrecognised robots value fails the build rather than silently indexing', async () => {
  // The failure mode this guards is invisible in the output: a page that meant
  // to be excluded and is quietly indexed looks identical in dist/.
  const { content, out } = build({ ...FILES, 'noindex.rvmark': `{robots: off}\n\n- Secret\n` });
  await assert.rejects(
    () => buildSite({ contentDir: content, outDir: out }),
    /robots must be 'index' or 'noindex'/,
  );
});

// ── sitemap ───────────────────────────────────────────────────────────────────

test('the sitemap lists every indexable page and omits noindex ones', async () => {
  const page = await buildFixture();
  const locs = [...page.file('sitemap.xml').matchAll(/<loc>([^<]*)<\/loc>/g)].map(m => m[1]);
  assert.deepEqual(locs.sort(), [
    `${ORIGIN}/`,
    `${ORIGIN}/deep/`,
    `${ORIGIN}/deep/leaf/`,
    `${ORIGIN}/plain/`,
    `${ORIGIN}/sub/`,
    `${ORIGIN}/sub/leaf/`,
  ]);
  page.cleanup();
});

test('robots.txt stays permissive and points at the sitemap', async () => {
  const page = await buildFixture();
  const txt = page.file('robots.txt');
  // Disallowing here would stop crawlers reading the pages, and therefore stop
  // them seeing any noindex — the classic mistake. Per-page exclusion is the
  // meta tag; robots.txt is not the mechanism for it.
  assert.doesNotMatch(txt, /Disallow:\s*\//);
  assert.match(txt, new RegExp(`Sitemap: ${ORIGIN}/sitemap\\.xml`));
  page.cleanup();
});

// ── no site-url ───────────────────────────────────────────────────────────────

test('without site-url the absolute-URL tags are omitted rather than emitted relative', async () => {
  const page = await buildFixture({ ...FILES, 'index.rvmark': `{title: Root; card-img: ./root.png}\n\n- Root node\n` });
  const html = page.root();
  // A crawler reading a relative canonical against the wrong base is worse than
  // no canonical at all.
  assert.equal(canonical(html), undefined);
  assert.equal(ogUrl(html),     undefined);
  assert.equal(ogImage(html),   undefined);
  // An image that cannot be made absolute is one no scraper would fetch, so the
  // card degrades to the form that still unfurls: title, description, domain.
  assert.equal(tagContent(html, 'name', 'twitter:card'), 'summary');
  page.cleanup();
});
