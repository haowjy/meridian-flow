import { Fragment, type Node as PMNode } from "prosemirror-model";

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const ID_LENGTH = 10;

export function newBlockId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(ID_LENGTH));
  let id = "";
  for (const byte of bytes) id += ALPHABET[byte % ALPHABET.length];
  return id;
}

export function hasBlockId(node: PMNode): boolean {
  return node.type.spec.attrs?.id !== undefined;
}

function mapIds(node: PMNode, idOf: (id: unknown) => unknown): PMNode {
  const children: PMNode[] = [];
  let changed = false;
  node.forEach((child) => {
    const next = mapIds(child, idOf);
    changed ||= next !== child;
    children.push(next);
  });
  const id = hasBlockId(node) ? idOf(node.attrs.id) : node.attrs.id;
  if (!changed && id === node.attrs.id) return node;
  const attrs = hasBlockId(node) ? { ...node.attrs, id } : node.attrs;
  return node.type.create(attrs, changed ? Fragment.fromArray(children) : node.content, node.marks);
}

export function withBlockIds<T extends PMNode>(node: T): T {
  return mapIds(node, (id) => id ?? newBlockId()) as T;
}

export function withoutBlockIds<T extends PMNode>(node: T): T {
  return mapIds(node, () => null) as T;
}
