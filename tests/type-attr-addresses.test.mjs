/**
 * type-attr-addresses.test.mjs — addresses declared by a node type, not the core.
 *
 * `src` belongs to image/video/iframe/block, not to every node, so it is declared
 * per type rather than as a core attribute. A tag def contributing `node.src`
 * still has to resolve against the file that defined the tag — the same rule the
 * core attrs follow, reached through the type's own declaration.
 *
 * Before the type declarations existed this resolved against the consuming page
 * and silently pointed at nothing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildSite } from '../out/build/site.js';
import { isAddressAttr, attrType, isTypeDeclared, defaultTypeName } from '../out/shared/node-types.js';
import '../out/types/declare.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

// The tag def lives only in the ROOT header; sub/ inherits it.
const FILES = {
  'index.rvmark':
    `{title: Root}\n` +
    `[RelImg {node.type: image; node.src: ./pics/dot.png}]\n` +
    `\n- [RelImg] Root image\n`,
  'sub/index.rvmark':
    `{title: Sub}\n\n- [RelImg] Sub image\n`,
  'pics/dot.png': PNG,
};

async function buildFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'rvmark-typeattr-'));
  const content = join(dir, 'rvmark');
  for (const [rel, src] of Object.entries(FILES)) {
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

function staticPart(html) {
  return html.slice(html.indexOf('id="static-content"'), html.indexOf('id="tree-scroll"'));
}

/** Every <img src> on the page, in document order. */
function imgSrcs(html) {
  return [...staticPart(html).matchAll(/<img[^>]*\ssrc="([^"]*)"/g)].map(m => m[1]);
}

// ── the registry itself ───────────────────────────────────────────────────────

test('src is an address on the types that declare it, and not on others', () => {
  for (const t of ['image', 'video', 'iframe', 'block'])
    assert.ok(isAddressAttr('src', t), `src should be an address on ${t}`);
  assert.ok(!isAddressAttr('src', 'text'), 'src is not declared on text');
  assert.ok(!isAddressAttr('src'), 'src is not a core attribute');
});

test('a type attribute shadows nothing it does not declare', () => {
  // bullet is core, so it stays an address seen through any type.
  assert.ok(isAddressAttr('bullet', 'image'));
  assert.equal(attrType('align', 'image'), 'text');
  assert.equal(attrType('align', 'text'), undefined);
});

test('every shipped type is declared, and text is the default', () => {
  for (const t of ['text', 'block', 'video', 'iframe', 'image', 'tr', 'table', 'hr', 'gap', 'loading'])
    assert.ok(isTypeDeclared(t), `${t} should be declared`);
  assert.ok(!isTypeDeclared('nosuchtype'));
  assert.equal(defaultTypeName(), 'text');
});

test('on-destroy is declared, having been implemented but never listed', () => {
  assert.equal(attrType('on-destroy'), 'expr');
});

// ── the behaviour that motivated it ───────────────────────────────────────────

test('a relative node.src resolves on the page that defines the tag', async () => {
  const page = await buildFixture();
  const [src] = imgSrcs(page.root());
  assert.ok(/(^|\/)_rvmark\/pics\/dot\.png$/.test(src), `root image src wrong: ${src}`);
  page.cleanup();
});

test('a relative node.src resolves against the defining file one level down', async () => {
  const page = await buildFixture();
  const [src] = imgSrcs(page('sub'));
  // The bug resolved this against sub/, giving a _rvmark/sub/pics/ URL that is
  // nothing. The emitted URL is relative to the page, so one level down it climbs.
  assert.ok(/_rvmark\/pics\/dot\.png$/.test(src), `sub image src wrong: ${src}`);
  assert.ok(!src.includes('/sub/'), `sub image resolved against the wrong file: ${src}`);
  page.cleanup();
});
