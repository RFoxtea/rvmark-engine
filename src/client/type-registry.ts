import type { NodeTypeFactory } from './render-node.js';

const _registry = new Map<string, NodeTypeFactory>();

export function factoryRegister(typeName: string, factory: NodeTypeFactory): void {
  _registry.set(typeName, factory);
}

export function factoryGet(typeName: string): NodeTypeFactory | undefined {
  return _registry.get(typeName);
}
