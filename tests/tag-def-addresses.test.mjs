/**
 * tag-def-addresses.test.mjs — addresses carried by an inherited tag definition.
 *
 * A tag def inherits down the index.rvmark chain, so it is read from files its
 * author never saw. The addresses in it — the chip's `href`, and the `node.*`
 * attrs it contributes — therefore have to resolve against the file that DEFINED
 * the tag, not the page that used it.
 *
 * Root-absolute values ('/icons/x.svg') resolve identically from anywhere, which
 * is why this stayed invisible: in practice tag defs are written that way. A
 * relative one written in a root header pointed at 'sub/icons/x.svg' one level
 * down, and a relative href was emitted unresolved entirely.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildSite } from '../out/build/site.js';

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>';

// The tag defs live only in the ROOT header; sub/ and deep/ inherit them.
const FILES = {
  'index.rvmark':
    `{title: Root}\n` +
    `[.relbullet {node.bullet: ./icons/rel.svg; node.bullet-alt: Rel}]\n` +
    `[.absbullet {node.bullet: /icons/rel.svg; node.bullet-alt: Abs}]\n` +
    `[RelHref    {href: ./target}]\n` +
    `[AbsHref    {href: /target}]\n` +
    `\n- [.relbullet] Root bullet\n- [RelHref] Root href\n`,
  'sub/index.rvmark':
    `{title: Sub}\n\n` +
    `- [.relbullet] Sub bullet\n` +
    `- [.absbullet] Sub abs bullet\n` +
    `- [RelHref] Sub href\n` +
    `- [AbsHref] Sub abs href\n`,
  'deep/nest/index.rvmark':
    `{title: Deep}\n\n- [.relbullet] Deep bullet\n- [RelHref] Deep href\n`,
  'target.rvmark': `- Target\n`,
  'icons/rel.svg': SVG,
};

async function buildFixture(files = FILES) {
  const dir = mkdtempSync(join(tmpdir(), 'rvmark-tagdef-'));
  const content = join(dir, 'rvmark');
  for (const [rel, src] of Object.entries(files)) {
    const path = join(content, rel);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, src);
  }
  const out = join(dir, 'dist');
  await buildSite({ contentDir: content, outDir: out });
  const page = (stem) => readFileSync(join(out, stem, 'index.html'), 'utf8');
  page.root = () => readFileSync(join(out, 'index.html'), 'utf8');
  page.cleanup = () => rmSync(dir, { recursive: true, force: true });
  return page;
}

/** Only the static fallback: the hydrated tree is not built without a browser. */
function staticPart(html) {
  return html.slice(html.indexOf('id="static-content"'), html.indexOf('id="tree-scroll"'));
}

/** Every --node-bullet-image value on the page, in document order. */
function bulletUrls(html) {
  return [...staticPart(html).matchAll(/--node-bullet-image:url\(&quot;([^&]*)&quot;\)/g)].map(m => m[1]);
}

/** Every tag-chip href on the page, in document order. */
function chipHrefs(html) {
  return [...staticPart(html).matchAll(/class="node-tag node-tag--link" href="([^"]*)"/g)].map(m => m[1]);
}

// A bullet that resolved to a real file is inlined as a data URI; one that did
// not is emitted as the path it failed at. So "is a data URI" is exactly the
// question "did this resolve to the icon the author meant".
const isInlined = (url) => url.startsWith('data:image/svg+xml');

// ── node.* addresses ──────────────────────────────────────────────────────────

test('a relative tag bullet resolves on the page that defines the tag', async () => {
  const page = await buildFixture();
  const [bullet] = bulletUrls(page.root());
  assert.ok(isInlined(bullet), `root bullet did not resolve: ${bullet}`);
  page.cleanup();
});

test('a relative tag bullet resolves against the defining file one level down', async () => {
  const page = await buildFixture();
  // The bug: './icons/rel.svg' defined in index.rvmark resolving against
  // sub/index.rvmark, yielding the non-existent 'sub/icons/rel.svg'.
  const [bullet] = bulletUrls(page('sub'));
  assert.ok(isInlined(bullet), `inherited bullet resolved against the wrong file: ${bullet}`);
  page.cleanup();
});

test('a relative tag bullet resolves against the defining file two levels down', async () => {
  const page = await buildFixture();
  const [bullet] = bulletUrls(page('deep/nest'));
  assert.ok(isInlined(bullet), `inherited bullet resolved against the wrong file: ${bullet}`);
  page.cleanup();
});

test('a root-absolute tag bullet keeps working', async () => {
  // The form every real tag def uses. It resolves identically from anywhere,
  // and must not be disturbed by whatever fixes the relative case.
  const page = await buildFixture();
  const [, abs] = bulletUrls(page('sub'));
  assert.ok(isInlined(abs), `absolute bullet stopped resolving: ${abs}`);
  page.cleanup();
});

// ── href ──────────────────────────────────────────────────────────────────────

test('a relative tag href resolves to the page it names', async () => {
  const page = await buildFixture();
  // Emitted raw, a relative href is read against the CURRENT page's URL, so
  // './target' on /sub/ means /sub/target — a page that does not exist.
  const [href] = chipHrefs(page('sub'));
  assert.doesNotMatch(href, /^\.\//, `href was emitted unresolved: ${href}`);
  assert.match(href, /target/, `href lost its destination: ${href}`);
  page.cleanup();
});

test('a root-absolute tag href keeps working', async () => {
  const page = await buildFixture();
  const [, abs] = chipHrefs(page('sub'));
  assert.match(abs, /target/, `absolute href broke: ${abs}`);
  page.cleanup();
});

// ── the constraint any fix has to respect ─────────────────────────────────────

test('a tag defined in the using file still resolves against that file', async () => {
  // Provenance is per-definition, not per-site: a def written in sub/ resolves
  // against sub/, not against the root. A fix that pins every def to the root
  // header passes the tests above and breaks this one.
  const page = await buildFixture({
    ...FILES,
    'sub/index.rvmark':
      `{title: Sub}\n` +
      `[.localbullet {node.bullet: ./local.svg}]\n` +
      `\n- [.localbullet] Local bullet\n`,
    'sub/local.svg': SVG,
  });
  const [bullet] = bulletUrls(page('sub'));
  assert.ok(isInlined(bullet), `locally-defined bullet did not resolve: ${bullet}`);
  page.cleanup();
});

test('a nearer tag def overrides an inherited one of the same name', async () => {
  const page = await buildFixture({
    ...FILES,
    'sub/index.rvmark':
      `{title: Sub}\n` +
      `[.relbullet {node.bullet: ./own.svg}]\n` +
      `\n- [.relbullet] Overridden\n`,
    'sub/own.svg': SVG,
  });
  const [bullet] = bulletUrls(page('sub'));
  assert.ok(isInlined(bullet), `overriding def did not resolve against its own file: ${bullet}`);
  page.cleanup();
});
