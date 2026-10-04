// The static fallback links an origin ref transclusion to the declared origin's page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildSite } from '../out/build/site.js';

const FILES = {
  'index.rvmark': `{title: Root}\n\n@peer {url: https://peer.test}\n@sub {url: https://sub.test/_rvmark/notes}\n\n- Root node\n`,
  'deep/page.rvmark': [
    '- Page',
    '  - {=> @peer/dir/target#deep} Anchor',
    '  - {=> @peer/dir/target} Page',
    '  - {=> @peer} Root',
    '  - {=> @sub/a#b} Sub',
    '  - {=> @nope/foo} Undeclared',
    '',
  ].join('\n'),
};

test('origin ref transclusions link to the foreign origin', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rvmark-origin-ref-'));
  try {
    const content = join(dir, 'rvmark');
    for (const [rel, src] of Object.entries(FILES)) {
      mkdirSync(join(content, rel, '..'), { recursive: true });
      writeFileSync(join(content, rel), src);
    }
    await buildSite({ contentDir: content, outDir: join(dir, 'dist') });
    const html = readFileSync(join(dir, 'dist/deep/page/index.html'), 'utf8');
    const href = (label) => html.match(new RegExp(`<a class="static-ref static-ref--interpage" href="([^"]*)">${label}</a>`))?.[1];

    assert.equal(href('Anchor'), 'https://peer.test/dir/target/#deep');
    assert.equal(href('Page'),   'https://peer.test/dir/target/');
    assert.equal(href('Root'),   'https://peer.test/');
    assert.equal(href('Sub'),    'https://sub.test/notes/a/#b');
    assert.equal(href('Undeclared'), undefined);
    assert.doesNotMatch(html, /href="[^"]*@/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
