import './blastocyte.declare.js';
import { defaultTypeName } from '../shared/node-types.js';
import type { TypeHandler, NodeTypeFactory, RenderNode } from '../client/render-node.js';
import { factoryGet, factoryRegister } from '../client/type-registry.js';
import { resolveTransclusionConfig } from '../client/transclusion.js';
import { resolveRefOn } from '../client/origin-host.js';
import { buildStatePass } from '../client/state.js';
import { parsePass, treeNavKeydown, makeErrorNode } from '../client/handler-utils.js';
import { Multimap } from '../shared/multimap.js';

function differentiate(rn: RenderNode): TypeHandler {
  const node     = rn.rvNode;
  const attrs    = node.attrs;
  const typeName = attrs.get('type') ?? defaultTypeName();
  const factory  = factoryGet(typeName);

  // An unrenderable type is not reached here: the wire boundary rejects a node
  // whose type this side cannot draw, and an origin's nodetypes are its own
  // business — whatever it serves has already been through them. What is left
  // is the ordinary fallback for a node with no type at all.
  const handler = (factory ?? factoryGet(defaultTypeName())!).create(rn);
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

  return {
    content,
    selectable: true,
    managesReady: true,
    // Stop the animation timer if this node is torn down before it resolves
    // (e.g. a children-mode loading marker superseded by its settled content, or
    // a still-loading transclusion whose parent collapses).
    onDestroy() { (content as any)._stopLoading?.(); },
  };
}

// `loading` type — a programmatically-minted placeholder child that shows the
// loading animation while a children-mode transclusion resolves. Authors never
// write it; it is minted by makeLoadingNode (handler-utils). managesReady keeps it
// out of the setChildren mount race so it inherits the MOUNT_SETTLE_MS anti-flash.
factoryRegister('loading', { create: (rn) => loadingHandler(rn) });

export const blastocyteFactory: NodeTypeFactory = {
  create(rn: RenderNode): TypeHandler {
    const node  = rn.rvNode;
    const attrs = node.attrs;
    const { embedVal, transcludeMode } = resolveTransclusionConfig(node, attrs);

    if (transcludeMode === 'link') {
      const handler = loadingHandler(rn);
      rn.attachHandler(handler);

      resolveRefOn(node, embedVal).then((tgt: any) => {
        (handler.content as any)._stopLoading?.();
        if (tgt) {
          const passRaw = node.attrs.get('pass');
          // The same two tiers setChildren uses: the origin that answered, then
          // the scope that origin declared. A link-mode transclusion splices one
          // node in rather than a list, but the boundary question is identical.
          const crossesScope = tgt.address.baseUrl !== node.address.baseUrl
                            || tgt.stateScope !== node.stateScope;
          if (passRaw !== undefined || crossesScope) {
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
          // Same plain error row as the children-mode path — bullet + "<ref> not found".
          rn.replaceHandler(makeErrorNode(node, embedVal!, 'error'));
        }
      });

      return handler;
    }

    return differentiate(rn);
  },
};
