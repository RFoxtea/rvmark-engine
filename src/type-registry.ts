import type { NodeTypeFactory } from './render-node.js';

const _registry = new Map<string, NodeTypeFactory>();

let _bodyTypeRegistrar: ((typeName: string) => void) | null = null;
const _pendingBodyTypes: string[] = [];

export function setBodyTypeRegistrar(fn: (typeName: string) => void): void {
  _bodyTypeRegistrar = fn;
  for (const typeName of _pendingBodyTypes) fn(typeName);
  _pendingBodyTypes.length = 0;
}

export function factoryRegister(typeName: string, factory: NodeTypeFactory): void {
  _registry.set(typeName, factory);
  if (factory.collectsBody) {
    if (_bodyTypeRegistrar) _bodyTypeRegistrar(typeName);
    else _pendingBodyTypes.push(typeName);
  }
}

export function factoryGet(typeName: string): NodeTypeFactory | undefined {
  return _registry.get(typeName);
}
