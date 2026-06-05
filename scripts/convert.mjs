/**
 * convert.mjs
 *
 * Converts all .rvmark files from the old dot-separated numbering format:
 *   1.2.3. {params} Label
 *
 * to the new indent-based format:
 *     3. {params} Label
 *
 * Depth is derived from the number of dot-separated segments.
 * Each depth level is indented by INDENT spaces (default: 2).
 *
 * Usage:
 *   node convert.mjs [--indent N] [--dry-run]
 *
 * Options:
 *   --indent N   Spaces per depth level (default: 2)
 *   --dry-run    Print converted output without writing files
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const dryRun  = args.includes('--dry-run');
const indentArg = args.indexOf('--indent');
const INDENT  = indentArg !== -1 ? parseInt(args[indentArg + 1], 10) : 2;

// Regex matching the old node line format
// Captures: (full numbering e.g. "1.2.3") (optional trailing dot) (rest of line)
const OLD_NODE_RE = /^(\d+(?:\.\d+)*)\.?\s+(.*)$/;

// Matches a node line where {media: type} has a non-empty label after it.
// Captures: (indent) (ordinal+dot or bullet) (params block) (label)
const INLINE_MEDIA_RE = /^( *)([a-zA-Z0-9]+\.|[-*])\s+(\{[^}]*\bmedia:\s*\w+\b[^}]*\})\s+(\S.*)/;

// Pass 1: old dot-numbering → indent-based
function convertNumbering(src) {
  const lines = src.split('\n');
  const out = [];

  for (const line of lines) {
    const m = line.match(OLD_NODE_RE);
    if (m) {
      const parts   = m[1].split('.');
      const depth   = parts.length;
      const ordinal = parts[parts.length - 1];
      const rest    = m[2];
      const spaces  = ' '.repeat((depth - 1) * INDENT);
      out.push(`${spaces}${ordinal}. ${rest}`);
    } else {
      out.push(line);
    }
  }

  return out.join('\n');
}

// Pass 2: inline media+label → split into label node + labelless media child
function convertInlineMedia(src) {
  const lines = src.split('\n');
  const out = [];

  for (const line of lines) {
    const m = line.match(INLINE_MEDIA_RE);
    if (m) {
      const indent      = m[1];
      const ordinalPart = m[2]; // e.g. "1." or "-"
      const params      = m[3]; // e.g. "{media: markdown}"
      const label       = m[4];
      const childIndent = indent + ' '.repeat(INDENT);
      // Parent: label only (strip the media params)
      out.push(`${indent}${ordinalPart} ${label}`);
      // Child: media params, no label
      out.push(`${childIndent}- ${params}`);
    } else {
      out.push(line);
    }
  }

  return out.join('\n');
}

// Pass 3: migrate old param syntax to new
//   {media: markdown}              → {= markdown}
//   {media: html}                  → {= html}
//   {media: youtube; url: X}       → {= youtube} X   (url becomes label)
//   {media: image; url: X; ...}    → {= image; ...} X
//   {media: html; url: X}          → {= html} X
//   {/media}                       → {/=}
//   {embed: ref}                   → {=> ref}
function convertNewSyntax(src) {
  const lines = src.split('\n');
  const out = [];

  for (const line of lines) {
    // {/media} → {/=}
    if (line.trim() === '{/media}') {
      out.push(line.replace('{/media}', '{/=}'));
      continue;
    }

    // Node line: look for {media: ...} or {embed: ...} (legacy) in params block
    const nodeM = line.match(/^( *)(?:[a-zA-Z0-9]+\.|[-*])\s+/);
    if (nodeM) {
      let converted = line;

      // {embed: ref} → {=> ref}  (inside a params block)
      converted = converted.replace(/\{([^}]*)embed:\s*([^;}\s][^;}]*)([^}]*)\}/g, (match, pre, ref, post) => {
        const rest = (pre + post).replace(/;?\s*$/, '').replace(/^\s*;?/, '').trim();
        const inner = rest ? `${rest}; => ${ref.trim()}` : `=> ${ref.trim()}`;
        return `{${inner}}`;
      });

      // {media: youtube; url: X; ...extra} → {= youtube; ...extra} X
      // {media: image; url: X; ...extra}   → {= image; ...extra} X
      // {media: html; url: X}              → {= html} X
      converted = converted.replace(/\{([^}]*)\bmedia:\s*(youtube|image|html)\b([^}]*)\}/g, (match, pre, type, post) => {
        // Extract url from pre+post
        const allExtra = (pre + post);
        const urlM = allExtra.match(/(?:^|;)\s*url:\s*([^;]+)/);
        const url = urlM ? urlM[1].trim() : null;
        // Remaining params (strip url, strip leading/trailing semicolons/whitespace)
        const remaining = allExtra
          .replace(/(?:^|;)\s*url:[^;]*/g, '')
          .replace(/^\s*;?\s*/, '')
          .replace(/\s*;?\s*$/, '')
          .trim();
        const inner = remaining ? `= ${type}; ${remaining}` : `= ${type}`;
        if (url) {
          // url becomes label: append after closing brace
          return `{${inner}} ${url}`;
        }
        return `{${inner}}`;
      });

      // {media: markdown} / {media: html} (body types, no url) → {= markdown} / {= html}
      converted = converted.replace(/\{([^}]*)\bmedia:\s*(markdown|html)\b([^}]*)\}/g, (match, pre, type, post) => {
        const remaining = (pre + post)
          .replace(/^\s*;?\s*/, '')
          .replace(/\s*;?\s*$/, '')
          .trim();
        const inner = remaining ? `${remaining}; = ${type}` : `= ${type}`;
        return `{${inner}}`;
      });

      out.push(converted);
      continue;
    }

    out.push(line);
  }

  return out.join('\n');
}

function convertFile(src) {
  let result = convertNumbering(src);
  result = convertInlineMedia(result);
  result = convertNewSyntax(result);
  return result;
}

function findRvmarkFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findRvmarkFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.rvmark')) {
      results.push(full);
    }
  }
  return results;
}

const rvmarkDir = path.join(__dirname, 'rvmark');
const files = findRvmarkFiles(rvmarkDir);

let converted = 0;
for (const file of files) {
  const original = fs.readFileSync(file, 'utf8');
  const result   = convertFile(original);

  if (result === original) continue;

  const rel = path.relative(__dirname, file);
  if (dryRun) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`DRY RUN: ${rel}`);
    console.log('─'.repeat(60));
    console.log(result);
  } else {
    fs.writeFileSync(file, result, 'utf8');
    console.log(`converted: ${rel}`);
  }
  converted++;
}

console.log(`\n${dryRun ? '[dry run] ' : ''}${converted} file(s) ${dryRun ? 'would be ' : ''}converted (indent=${INDENT}).`);
