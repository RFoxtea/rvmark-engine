// tests/custom-types/echo.ts
//
// Test fixture: a minimal identity custom type. Passes the node through, only
// rewriting {type: echo} → {type: text} so the output is a built-in (a custom
// type must expand to a built-in; no recursion). Used by envoy.spec.js.

import type { PortableNode, CustomType } from 'rvmark/envoy';

export default {
  type: 'echo',
  transform(node: PortableNode): PortableNode {
    const attrs = node.attrs.filter(([k]) => k !== 'type');
    attrs.push(['type', 'text']);
    return { ...node, attrs };
  },
} satisfies CustomType;
