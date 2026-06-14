import type { TypeHandler, NodeTypeFactory, RenderNode } from '../render-node.js';
import { factoryGet } from '../type-registry.js';
import { tagsNodeAttrs, mergeNodeAttrs } from '../tags.js';
import { resolveTransclusionConfig, resolveRef } from '../transclusion.js';
import { buildStatePass } from '../state.js';
import { parsePass, treeNavKeydown } from '../handler-utils.js';
import { Multimap } from '../multimap.js';
import { createCustomTypeHandler } from './custom.js';

function differentiate(rn: RenderNode): TypeHandler {
  const node     = rn.sourceNode;
  const attrs    = mergeNodeAttrs(tagsNodeAttrs(node.tags, node.sourceFile?.tagDefs), node.attrs);
  const typeName = attrs.get('type') ?? 'text';
  const factory  = factoryGet(typeName);

  // Unknown type with an explicit `type` attr → site-defined custom type. Route
  // it through its origin's envoy (sandboxed author code). A bare node with no
  // type, or an unresolvable empty type, still falls back to `text`.
  if (!factory && typeName !== 'text') {
    return createCustomTypeHandler(rn, typeName);
  }

  const handler = (factory ?? factoryGet('text')!).create(rn);
  rn.attachHandler(handler);
  return handler;
}

export function loadingHandler(rn: RenderNode): TypeHandler {
  const content = document.createElement('div');
  content.classList.add('node-content--loading');
  content.setAttribute('role', 'treeitem');
  content.tabIndex = -1;
  content.setAttribute('aria-selected', 'false');

  const lbl = document.createElement('span');
  lbl.className = 'node-label';
  const FRAMES = ['.', '..', '...'];
  let fi = 0;
  lbl.textContent = FRAMES[fi];
  const iv = setInterval(() => { lbl.textContent = FRAMES[fi = (fi + 1) % FRAMES.length]; }, 500);
  (content as any)._stopLoading = () => clearInterval(iv);
  content.appendChild(lbl);

  content.addEventListener('keydown', (e) => {
    treeNavKeydown(e, content, rn.li);
  });

  return { content, selectable: true, managesReady: true };
}

export const blastocyteFactory: NodeTypeFactory = {
  create(rn: RenderNode): TypeHandler {
    const node  = rn.sourceNode;
    const attrs = mergeNodeAttrs(tagsNodeAttrs(node.tags, node.sourceFile?.tagDefs), node.attrs);
    const { embedVal, transcludeMode } = resolveTransclusionConfig(node, attrs);

    if (transcludeMode === 'link') {
      const handler = loadingHandler(rn);
      rn.attachHandler(handler);

      resolveRef(embedVal, node.sourceFile.pageAddress).then((tgt: any) => {
        (handler.content as any)._stopLoading?.();
        if (tgt) {
          const passRaw = node.attrs.get('pass');
          const isCrossFile = tgt.sourceFile?.pageAddress !== node.sourceFile.pageAddress;
          if (passRaw !== undefined || isCrossFile) {
            rn.state.parent = buildStatePass(rn.state.parent, passRaw !== undefined ? parsePass(passRaw) : []);
          }
          const mergedAttrs = new Multimap();
          for (const [k, v] of tgt.attrs.allEntries()) mergedAttrs.append(k, v);
          for (const [k, v] of node.attrs.allEntries()) if (k !== 'transclude') mergedAttrs.append(k, v);
          const mergedNode = {
            ...tgt,
            attrs: mergedAttrs,
            tags:  [...node.tags, ...tgt.tags],
          };
          rn.replaceHandler(mergedNode);
        } else {
          handler.content.querySelector('.node-label')!.textContent = `${embedVal} not found`;
        }
      });

      return handler;
    }

    return differentiate(rn);
  },
};
