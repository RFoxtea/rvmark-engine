/**
 * browser.ts — renderSite for a browser host.
 *
 * Installs the globals render-site.ts reads at import, as site.ts does under
 * Node. DOMPurify is the identity here too, so both hosts render identically.
 */

import './browser-globals.js';
export { renderSite, contentOutDir } from './render-site.js';
export type { RenderSiteInput } from './render-site.js';
