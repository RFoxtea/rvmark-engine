/**
 * page-context.ts
 *
 * The page the client is currently showing: the .rvmark file it booted from and
 * the base path its links are written against. Set once by main.ts out of
 * window.__RVMARK_PAGE__, read by exhibit.ts when it rewrites relative links.
 *
 * Client state, not origin storage. It lived in the loader while the loader was
 * the only thing that knew about pages, but nothing origin-side reads it: an
 * origin answers by key and has no notion of which page a reader happens to be
 * on. Keeping it here is what lets the client hold it across the wire cut.
 */

export interface PageContext {
  file:     string;
  basePath: string;
}

let _ctx: PageContext = { file: '', basePath: '' };

export function setPageContext(file: string, basePath: string): void {
  _ctx = { file, basePath };
}

export function getPageContext(): PageContext {
  return _ctx;
}
