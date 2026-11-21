import { simpleDiff } from "lib0/diff";
import { equalityDeep } from "lib0/function";
import {
  type ContainerID,
  type Delta,
  isContainer,
  type LoroDoc,
  type LoroEventBatch,
  LoroList,
  LoroMap,
  LoroText,
  type LoroTree,
  type Value,
} from "loro-crdt";
import type { Attrs, Mark, Node, ResolvedPos, Schema } from "prosemirror-model";
import { type EditorState, TextSelection, type Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

import { type ChildKey, movedBlockIds, pairByBlockId } from "./block-id";
import { markFromStored, markKey, marksToStored, markValue, valueToAttrs } from "./text-style";

export type LoroChildrenListType = LoroList<LoroMap<LoroNodeContainerType> | LoroText>;
export type LoroNodeContainerType = {
  [CHILDREN_KEY]: LoroChildrenListType;
  [ATTRIBUTES_KEY]: LoroMap;
  [NODE_NAME_KEY]: string;
};

export type LoroDocType = LoroDoc<{
  doc: LoroMap<LoroNodeContainerType>;
  data: LoroMap;
}>;
export type LoroNode = LoroMap<LoroNodeContainerType>;
export type LoroContainer =
  | LoroChildrenListType
  | LoroMap<LoroNodeContainerType>
  | LoroText
  | LoroTree;
export type LoroType = LoroContainer | Value;

// Mapping from a Loro Container ID to a ProseMirror non-text node
// or to the children of a ProseMirror text node.
//
// - For an non-text, it will be a LoroMap mapping to a Node
// - For a text, it will be a LoroText mapping to several Nodes.
//   (PM stores rich text as arrays of text nodes, each one with its marks,
//   and that's why we have some conversion utilities between both)
//
// So ContainerID should always be of a LoroMap or a LoroText.
// Anything else is considered an error.
//
// A PM non-text node, it has attributes and children, which represents as a
// LoroMap with a `"attributes": LoroMap` and a `"children": LoroList` inside
// of it. Both that attributes and children are just part of the parent LoroMap
// structure, which is mapped to an actual node.
//
// See also: https://prosemirror.net/docs/guide/#doc.data_structures
export type LoroNodeMapping = Map<ContainerID, Node | Node[]>;

export const ROOT_DOC_KEY = "doc";
export const ATTRIBUTES_KEY = "attributes";
export const CHILDREN_KEY = "children";
export const NODE_NAME_KEY = "nodeName";
export const MARKS_KEY = "marks";
/**
 * Maps PM non-text nodes to their corresponding Loro Container IDs.
 */
export const WEAK_NODE_TO_LORO_CONTAINER_MAPPING = new WeakMap<Node, ContainerID>();

/**
 * One PM→Loro reconciliation. `deltas`: a reconciliation visits the same LoroText from
 * equality checks and the eventual update, so its materialization is kept for the pass and
 * never escapes a mutation or a later transaction. `movedIds`: the block ids this pass's
 * transactions moved (`movedBlockIds`), for `pairByBlockId`.
 */
export type SyncPass = {
  deltas: Map<ContainerID, Delta<string>[]>;
  movedIds: ReadonlySet<string>;
};

const NO_MOVES: ReadonlySet<string> = new Set();

export function newSyncPass(movedIds: ReadonlySet<string> = NO_MOVES): SyncPass {
  return { deltas: new Map(), movedIds };
}

function cachedTextDelta(obj: LoroText, pass: SyncPass): Delta<string>[] {
  const cached = pass.deltas.get(obj.id);
  if (cached != null) return cached;
  const delta = obj.toDelta();
  pass.deltas.set(obj.id, delta);
  return delta;
}

function invalidateTextDelta(obj: LoroText, pass: SyncPass) {
  pass.deltas.delete(obj.id);
}

/** The local change a PM→Loro write carries: what lets it take the fast path, and its commit origin. */
export type LocalChange = {
  transactions: readonly Transaction[];
  oldEditorState: EditorState;
  /** The Loro commit origin (`setCommitOrigin`), so an UndoManager can scope by it. */
  origin?: string;
};

export const DEFAULT_COMMIT_ORIGIN = "loroSyncPlugin";

export function updateLoroToPmState(
  doc: LoroDocType,
  mapping: LoroNodeMapping,
  editorState: EditorState,
  containerId?: ContainerID,
  change?: LocalChange,
) {
  const node = editorState.doc;
  const map = containerId
    ? (doc.getContainerById(containerId) as LoroMap<LoroNodeContainerType>)
    : doc.getMap(ROOT_DOC_KEY);

  let isInit = false;
  if (map.get("nodeName") == null) {
    doc.commit();
    isInit = true;
    map.set("nodeName", node.type.name);
  }

  if (
    !tryUpdateLoroTextFromTransaction(
      doc,
      map,
      mapping,
      change?.oldEditorState,
      editorState,
      change?.transactions,
    )
  ) {
    updateLoroMap(
      map,
      node,
      mapping,
      newSyncPass(change ? movedBlockIds(change.transactions) : NO_MOVES),
    );
  }
  doc.commit({
    origin: isInit ? "sys:init" : (change?.origin ?? DEFAULT_COMMIT_ORIGIN),
  });
}

export function createNodeFromLoroObj(
  schema: Schema,
  obj: LoroNode,
  mapping: LoroNodeMapping,
): Node;
export function createNodeFromLoroObj(
  schema: Schema,
  obj: LoroText,
  mapping: LoroNodeMapping,
): Node[];
export function createNodeFromLoroObj(
  schema: Schema,
  obj: LoroNode | LoroText,
  mapping: LoroNodeMapping,
): Node | Node[] | null {
  let retval: Node | Node[] | null = mapping.get(obj.id) ?? null;
  if (retval != null) {
    return retval;
  }

  if (obj instanceof LoroMap) {
    const attributes = getLoroMapAttributes(obj);
    const children = getLoroMapChildren(obj);

    const nodeName = obj.get("nodeName");
    if (nodeName == null || typeof nodeName !== "string") {
      throw new Error("Invalid nodeName");
    }

    const mappedChildren = children
      .toArray()
      .flatMap((child) => createNodeFromLoroObj(schema, child as any, mapping))
      .filter((n) => n !== null);

    try {
      retval = schema.node(
        nodeName,
        attributes.toJSON(),
        mappedChildren,
        storedNodeMarks(schema, obj),
      );
      WEAK_NODE_TO_LORO_CONTAINER_MAPPING.set(retval, obj.id);
    } catch (e) {
      // An error occurred while creating the node.
      // This is probably a result of a concurrent action.
      console.error(e);
    }
  } else if (obj instanceof LoroText) {
    retval = [];
    for (const delta of obj.toDelta()) {
      if (delta.insert == null) {
        continue;
      }

      try {
        const marks = [];
        for (const [key, value] of Object.entries(delta.attributes ?? {})) {
          marks.push(markFromStored(schema, key, value));
        }
        retval.push(schema.text(delta.insert, marks));
      } catch (e) {
        // An error occurred while creating the node.
        // This is probably a result of a concurrent action.
        console.error(e);
      }
    }
  } else {
    /* v8 ignore next */
    throw new Error("Invalid LoroType");
  }

  if (retval != null) {
    if (!Array.isArray(retval)) {
      WEAK_NODE_TO_LORO_CONTAINER_MAPPING.set(retval, obj.id);
    }
    mapping.set(obj.id, retval);
  } else {
    mapping.delete(obj.id);
  }

  return retval;
}

export function createLoroChild(
  parentList: LoroChildrenListType,
  pos: number | null,
  nodeOrNodeList: Node | Node[],
  mapping: LoroNodeMapping,
): LoroText | LoroMap {
  return Array.isArray(nodeOrNodeList)
    ? createLoroText(parentList, pos, nodeOrNodeList, mapping)
    : createLoroMap(parentList, pos, nodeOrNodeList, mapping);
}

export function createLoroText(
  parentList: LoroList,
  pos: number | null,
  nodes: Node[],
  mapping: LoroNodeMapping,
): LoroText {
  const obj = parentList.insertContainer(pos ?? parentList.length, new LoroText()).getAttached()!;

  const delta: Delta<string>[] = nodes.map((node) => ({
    insert: node.text!,
    attributes: marksToStored(node.marks),
  }));
  obj.applyDelta(delta);

  mapping.set(obj.id, nodes);
  return obj;
}

export function updateLoroText(
  obj: LoroText,
  nodes: Node[],
  mapping: LoroNodeMapping,
  pass: SyncPass = newSyncPass(),
) {
  mapping.set(obj.id, nodes);

  const before = cachedTextDelta(obj, pass);
  const str = before.map((part) => part.insert ?? "").join("");
  const content = nodes.map((p) => ({
    insert: p.text!,
    attributes: marksToStored(p.marks),
  }));
  const { insert, remove, index } = simpleDiff(str, content.map((c) => c.insert).join(""));
  if (remove > 0) {
    invalidateTextDelta(obj, pass);
    obj.delete(index, remove);
  }
  if (insert.length) {
    invalidateTextDelta(obj, pass);
    obj.insert(index, insert);
  }

  // Only apply marks over the ranges where the LoroText still disagrees with
  // ProseMirror. Loro records every mark/unmark op it is asked to apply, even
  // ones that don't change the visible styles (they still carry meaning under
  // concurrent editing), so re-asserting the marks of the whole text on every
  // change would emit style ops on every keystroke. After the text diff above,
  // inserts already inherit the styles configured by `configLoroTextStyle`, so
  // typing, deleting, and plain pastes need no style ops at all.
  const styles = diffTextStyles(cachedTextDelta(obj, pass), content);
  if (styles != null) {
    invalidateTextDelta(obj, pass);
    obj.applyDelta(styles);
  }
}

/**
 * Computes the minimal delta that restyles `current` (what the LoroText
 * holds) as `content` (what ProseMirror wants). The text of both sides must
 * already be equal. Returns null when the styles already agree everywhere.
 */
function diffTextStyles(
  current: Delta<string>[],
  content: { insert: string; attributes: { [key: string]: Value | Attrs } }[],
): Delta<string>[] | null {
  const styles: Delta<string>[] = [];
  let i = 0;
  let iUsed = 0;
  let j = 0;
  let jUsed = 0;
  while (i < current.length && j < content.length) {
    const currentRun = current[i];
    const contentRun = content[j];
    if (currentRun.insert == null) {
      i += 1;
      continue;
    }

    const length = Math.min(currentRun.insert.length - iUsed, contentRun.insert.length - jUsed);
    if (length > 0) {
      const patch = attributesPatch(currentRun.attributes ?? {}, contentRun.attributes);
      styles.push(patch != null ? { retain: length, attributes: patch } : { retain: length });
    }

    iUsed += length;
    if (iUsed === currentRun.insert.length) {
      i += 1;
      iUsed = 0;
    }
    jUsed += length;
    if (jUsed === contentRun.insert.length) {
      j += 1;
      jUsed = 0;
    }
  }

  while (styles.length > 0 && styles[styles.length - 1].attributes == null) {
    styles.pop();
  }
  return styles.length > 0 ? styles : null;
}

/**
 * Computes the attribute changes that turn `current` into `wanted`, or null
 * if they are already equal.
 */
function attributesPatch(
  current: { [key: string]: Value | Attrs },
  wanted: { [key: string]: Value | Attrs },
): { [key: string]: Value | Attrs | null } | null {
  let patch: { [key: string]: Value | Attrs | null } | null = null;
  for (const [key, attrs] of Object.entries(wanted)) {
    if (!equalityDeep(current[key], attrs)) {
      patch = patch ?? {};
      patch[key] = attrs;
    }
  }
  for (const key of Object.keys(current)) {
    if (!(key in wanted) && current[key] != null) {
      patch = patch ?? {};
      patch[key] = null;
    }
  }
  return patch;
}

/**
 * The normal typing case is a single closed ReplaceStep inside one existing
 * text-only block. Updating that LoroText directly preserves its identity and
 * avoids the repeated `toDelta()` traversal that a whole-tree reconciliation
 * needs. Reject anything even slightly less regular before mutation.
 */
function tryUpdateLoroTextFromTransaction(
  doc: LoroDocType,
  root: LoroNode,
  mapping: LoroNodeMapping,
  oldEditorState: EditorState | undefined,
  editorState: EditorState,
  transactions: readonly Transaction[] | undefined,
): boolean {
  if (oldEditorState == null || transactions == null) return false;
  const changed = transactions.filter((tr) => tr.docChanged);
  if (changed.length !== 1 || changed[0].steps.length !== 1) return false;
  const transaction = changed[0];
  const step = transaction.steps[0];
  // Do not use `instanceof`: applications can bundle a second copy of
  // prosemirror-transform. ReplaceAroundStep has the same slice fields, so
  // use ProseMirror's serialized discriminator before inspecting it.
  if (
    step.toJSON().stepType !== "replace" ||
    !("from" in step) ||
    !("to" in step) ||
    !("slice" in step)
  )
    return false;
  const replace = step as typeof step & {
    from: number;
    to: number;
    slice: {
      openStart: number;
      openEnd: number;
      content: { content: readonly Node[] };
    };
  };
  if (replace.slice.openStart !== 0 || replace.slice.openEnd !== 0) return false;
  if (replace.slice.content.content.some((child) => !child.isText)) return false;

  const oldPos = oldEditorState.doc.resolve(replace.from);
  const newPos = editorState.doc.resolve(replace.from);
  if (
    oldPos.depth !== newPos.depth ||
    !oldPos.parent.isTextblock ||
    !allText(oldPos.parent) ||
    !allText(newPos.parent) ||
    replace.to > oldPos.end(oldPos.depth) ||
    !sameAncestors(oldPos, newPos)
  )
    return false;

  for (let depth = 0; depth <= oldPos.depth; depth++) {
    const ancestor = oldPos.node(depth);
    const id = depth === 0 ? root.id : WEAK_NODE_TO_LORO_CONTAINER_MAPPING.get(ancestor);
    if (id == null || mapping.get(id) !== ancestor) return false;
  }
  const parentId = WEAK_NODE_TO_LORO_CONTAINER_MAPPING.get(oldPos.parent);
  if (parentId == null) return false;
  const parent = doc.getContainerById(parentId) as LoroNode | undefined;
  if (!(parent instanceof LoroMap)) return false;
  const oldTextNodes = oldPos.parent.content.content;
  const text = getLoroMapChildren(parent)
    .toArray()
    .find(
      (child) =>
        child instanceof LoroText && mappedTextMatches(mapping.get(child.id), oldTextNodes),
    );
  if (!(text instanceof LoroText)) return false;

  const from = oldPos.parentOffset;
  const to = from + replace.to - replace.from;
  if (from < 0 || to < from || to > text.length) return false;
  const newTextNodes = newPos.parent.content.content;
  const markKeys = markKeysForNodes(oldTextNodes, newTextNodes);
  text.applyDelta([
    ...(from === 0 ? [] : [{ retain: from }]),
    ...(to === from ? [] : [{ delete: to - from }]),
    ...replace.slice.content.content.map((child) => ({
      insert: child.text!,
      attributes: completeMarkAttributes(child.marks, markKeys),
    })),
  ]);
  refreshChangedAncestorMappings(mapping, root, text.id, oldPos, newPos, newTextNodes);
  return true;
}

function allText(node: Node): boolean {
  return node.content.content.every((child) => child.isText);
}

function sameAncestors(oldPos: ResolvedPos, newPos: ResolvedPos): boolean {
  for (let depth = 0; depth <= oldPos.depth; depth++) {
    const oldNode = oldPos.node(depth);
    const newNode = newPos.node(depth);
    if (oldNode.type !== newNode.type || !eqAttrs(oldNode.attrs, newNode.attrs)) return false;
  }
  return true;
}

function mappedTextMatches(mapped: Node | Node[] | undefined, nodes: readonly Node[]): boolean {
  return (
    Array.isArray(mapped) &&
    mapped.length === nodes.length &&
    mapped.every((node, index) => node === nodes[index])
  );
}

function refreshChangedAncestorMappings(
  mapping: LoroNodeMapping,
  root: LoroNode,
  textId: ContainerID,
  oldPos: ResolvedPos,
  newPos: ResolvedPos,
  newTextNodes: readonly Node[],
) {
  for (let depth = 0; depth <= oldPos.depth; depth++) {
    const oldNode = oldPos.node(depth);
    const newNode = newPos.node(depth);
    const id = depth === 0 ? root.id : WEAK_NODE_TO_LORO_CONTAINER_MAPPING.get(oldNode);
    if (id == null) continue;
    mapping.set(id, newNode);
    WEAK_NODE_TO_LORO_CONTAINER_MAPPING.set(newNode, id);
  }
  // The text container itself keeps its original Loro identity.
  mapping.set(textId, [...newTextNodes]);
}

function markKeysForNodes(...nodeGroups: readonly (readonly Node[])[]): Set<string> {
  const keys = new Set<string>();
  for (const nodes of nodeGroups)
    for (const node of nodes) for (const mark of node.marks) keys.add(markKey(mark));
  return keys;
}

function completeMarkAttributes(
  marks: readonly Mark[],
  markKeys: ReadonlySet<string>,
): { [key: string]: Value | Attrs | null } {
  const attrs: { [key: string]: Value | Attrs | null } = {};
  for (const key of markKeys) attrs[key] = null;
  Object.assign(attrs, marksToStored(marks));
  return attrs;
}

function eqStoredMark(value: unknown, mark: Mark): boolean {
  const wanted = markValue(mark);
  const attrs = valueToAttrs(value);
  const wantedAttrs = valueToAttrs(wanted);
  return attrs != null && wantedAttrs != null ? eqAttrs(attrs, wantedAttrs) : value === wanted;
}

function eqLoroTextNodes(obj: LoroText, nodes: Node[], pass: SyncPass) {
  const delta = cachedTextDelta(obj, pass);
  return (
    delta.length === nodes.length &&
    delta.every(
      (delta, i) =>
        delta.insert === nodes[i].text &&
        Object.keys(delta.attributes || {}).length === nodes[i].marks.length &&
        nodes[i].marks.every((mark) => eqStoredMark((delta.attributes || {})[markKey(mark)], mark)),
    )
  );
}

// TODO: extract code about equality into a single file
/**
 * Whether the loro object is equal to the node.
 */
function eqLoroObjNode(obj: LoroType, node: Node | Node[], pass: SyncPass): boolean {
  if (obj instanceof LoroMap) {
    if (Array.isArray(node) || !eqNodeName(obj, node)) {
      return false;
    }

    const loroChildren = getLoroMapChildren(obj);
    const normalizedContent = normalizeNodeContent(node);
    return (
      loroChildren.length === normalizedContent.length &&
      eqAttrs(getLoroMapAttributes(obj).toJSON(), node.attrs) &&
      eqNodeMarks(obj, node) &&
      normalizedContent.every((childNode, i) =>
        eqLoroObjNode(loroChildren.get(i)!, childNode, pass),
      )
    );
  }

  return obj instanceof LoroText && Array.isArray(node) && eqLoroTextNodes(obj, node, pass);
}

function eqAttrs(attrs1: Attrs, attrs2: Attrs) {
  const keys = Object.keys(attrs1).filter((key) => attrs1[key] !== null);
  let eq = keys.length === Object.keys(attrs2).filter((key) => attrs2[key] !== null).length;
  for (let i = 0; eq && i < keys.length; i++) {
    const key = keys[i];
    const l = attrs1[key];
    const r = attrs2[key];
    eq =
      l === r ||
      (typeof l === "object" && l !== null && typeof r === "object" && r !== null && eqAttrs(l, r));
  }
  return eq;
}

function eqNodeName(obj: LoroMap, node: Node | Node[]): boolean {
  return !Array.isArray(node) && obj.get("nodeName") === node.type.name;
}

/**
 * Checks if two nodes (or arrays of nodes) are equal.
 * - If both are the same object, returns true.
 * - If both are single nodes, uses their .eq() method.
 * - If both are arrays, checks that they have the same length and each corresponding node is equal.
 */
function eqMappedNode(mapped: Node | Node[] | undefined, node: Node | Node[] | undefined): boolean {
  // If both are the same reference, they are equal
  if (mapped === node) {
    return true;
  }

  // If both are single nodes (not arrays), compare using .eq()
  if (!Array.isArray(mapped) && !Array.isArray(node) && node) {
    return mapped?.eq(node) ?? false;
  }

  // If both are arrays, check length and each element
  if (Array.isArray(mapped) && Array.isArray(node)) {
    if (mapped.length !== node.length) {
      return false;
    }
    for (let i = 0; i < mapped.length; i++) {
      if (!node[i].eq(mapped[i])) {
        return false;
      }
    }
    return true;
  }

  // Otherwise, not equal
  return false;
}

function normalizeNodeContent(node: Node): (Node | Node[])[] {
  const res: (Node | Node[])[] = [];
  let textNodes: Node[] | null = null;

  node.content.forEach((node, _offset, _i) => {
    if (node.isText) {
      if (textNodes == null) {
        textNodes = [];
        res.push(textNodes);
      }
      textNodes.push(node);
    } else {
      res.push(node);
      textNodes = null;
    }
  });

  return res;
}

function computeChildEqualityFactor(
  obj: LoroNode,
  node: Node,
  mapping: LoroNodeMapping,
  pass: SyncPass,
): {
  factor: number;
  foundMappedChild: boolean;
} {
  const loroChildren = getLoroMapChildren(obj);
  const loroChildLength = loroChildren.length;

  const nodeChildren = normalizeNodeContent(node);
  const nodeChildLength = nodeChildren.length;

  const minLength = Math.min(loroChildLength, nodeChildLength);
  let left = 0;
  let right = 0;

  let foundMappedChild = false;
  for (; left < minLength; left++) {
    const leftLoro = loroChildren.get(left);
    const leftNode = nodeChildren[left];
    if (
      eqMappedNode(
        leftLoro != null && isContainer(leftLoro) ? mapping.get(leftLoro.id) : undefined,
        leftNode,
      )
    ) {
      foundMappedChild = true; // good match!
    } else if (leftLoro == null || leftNode == null || !eqLoroObjNode(leftLoro, leftNode, pass)) {
      break;
    }
  }
  for (; left + right < minLength; right++) {
    const rightLoro = loroChildren.get(loroChildLength - right - 1);
    const rightNode = nodeChildren[nodeChildLength - right - 1];
    if (
      eqMappedNode(
        rightLoro != null && isContainer(rightLoro) ? mapping.get(rightLoro.id) : undefined,
        rightNode,
      )
    ) {
      foundMappedChild = true; // good match!
    } else if (
      rightLoro == null ||
      rightNode == null ||
      !eqLoroObjNode(rightLoro, rightNode, pass)
    ) {
      break;
    }
  }
  return {
    factor: left + right,
    foundMappedChild,
  };
}

export function createLoroMap(
  parentList: LoroChildrenListType,
  pos: number | null,
  node: Node,
  mapping: LoroNodeMapping,
): LoroMap {
  const obj = parentList
    .insertContainer(pos ?? parentList.length, new LoroMap())
    .getAttached()! as LoroNode;

  obj.set("nodeName", node.type.name);

  const attrs = getLoroMapAttributes(obj);
  for (const [key, value] of Object.entries(node.attrs)) {
    if (value !== null) {
      attrs.set(key, value);
    }
  }
  if (node.marks.length > 0) {
    const marks = getLoroMapMarks(obj);
    for (const [key, value] of Object.entries(marksToStored(node.marks))) {
      marks.set(key, value as Value);
    }
  }

  const children = getLoroMapChildren(obj);
  for (const child of normalizeNodeContent(node)) {
    createLoroChild(children, null, child, mapping);
  }

  WEAK_NODE_TO_LORO_CONTAINER_MAPPING.set(node, obj.id);
  mapping.set(obj.id, node);
  return obj;
}

export function updateLoroMap(
  obj: LoroNode,
  node: Node,
  mapping: LoroNodeMapping,
  pass: SyncPass = newSyncPass(),
) {
  mapping.set(obj.id, node);
  WEAK_NODE_TO_LORO_CONTAINER_MAPPING.set(node, obj.id);

  if (!eqNodeName(obj, node)) {
    throw new Error("node name mismatch!");
  }

  updateLoroMapAttributes(obj, node, mapping);
  updateLoroMapMarks(obj, node);
  updateLoroMapChildren(obj, node, mapping, pass);
}

export function getLoroMapAttributes(obj: LoroMap): LoroMap<{ [key: string]: string }> {
  return obj.getOrCreateContainer(ATTRIBUTES_KEY, new LoroMap());
}

/**
 * The marks on an inline non-text node (a comment on a hard break, a link on an image), by
 * `markKey`. Text marks are Loro styles on the text; a node has no text to style.
 */
export function getLoroMapMarks(obj: LoroMap): LoroMap {
  return obj.getOrCreateContainer(MARKS_KEY, new LoroMap());
}

function storedNodeMarks(schema: Schema, obj: LoroMap): Mark[] {
  const marks = obj.get(MARKS_KEY);
  if (!(marks instanceof LoroMap) || marks.size === 0) return [];
  return Object.entries(marks.toJSON()).map(([key, value]) => markFromStored(schema, key, value));
}

function updateLoroMapMarks(obj: LoroMap, node: Node): void {
  const stored = obj.get(MARKS_KEY);
  if (node.marks.length === 0 && !(stored instanceof LoroMap)) return;
  const marks = getLoroMapMarks(obj);
  const wanted = marksToStored(node.marks);
  for (const [key, value] of Object.entries(wanted)) {
    if (!equalityDeep(marks.get(key), value)) marks.set(key, value as Value);
  }
  for (const key of marks.keys()) {
    if (!(key in wanted)) marks.delete(key);
  }
}

function eqNodeMarks(obj: LoroMap, node: Node): boolean {
  const stored = obj.get(MARKS_KEY);
  const current = stored instanceof LoroMap ? (stored.toJSON() as Record<string, unknown>) : {};
  const wanted = marksToStored(node.marks);
  const keys = Object.keys(current);
  return (
    keys.length === Object.keys(wanted).length &&
    keys.every((key) => equalityDeep(current[key], wanted[key]))
  );
}

export function updateLoroMapAttributes(obj: LoroMap, node: Node, _mapping: LoroNodeMapping): void {
  const attrs = getLoroMapAttributes(obj);
  const keys = new Set(attrs.keys());

  const pAttrs = node.attrs;
  for (const [key, value] of Object.entries(pAttrs)) {
    if (value !== null) {
      if (!equalityDeep(attrs.get(key), value)) {
        attrs.set(key, value);
      }
    } else if (keys.has(key)) {
      attrs.delete(key);
    }
    keys.delete(key);
  }

  // remove all keys that are no longer in pAttrs
  for (const key of keys) {
    attrs.delete(key);
  }
}

export function getLoroMapChildren(obj: LoroNode): LoroChildrenListType {
  return obj.getOrCreateContainer(CHILDREN_KEY, new LoroList());
}

export function updateLoroMapChildren(
  obj: LoroNode,
  node: Node,
  mapping: LoroNodeMapping,
  pass: SyncPass = newSyncPass(),
): void {
  const loroChildren = getLoroMapChildren(obj);
  let loroChildLength = loroChildren.length;

  const nodeChildren = normalizeNodeContent(node);
  const nodeChildLength = nodeChildren.length;

  const minLength = Math.min(nodeChildLength, loroChildLength);
  let left = 0;
  let right = 0;

  // find number of matching elements from left
  for (; left < minLength; left++) {
    const leftLoro = loroChildren.get(left);
    const leftNode = nodeChildren[left];
    if (leftLoro == null || leftNode == null) {
      break;
    }

    if (isContainer(leftLoro) && mapping.get(leftLoro.id) !== leftNode) {
      if (
        eqMappedNode(mapping.get(leftLoro.id), leftNode) ||
        eqLoroObjNode(leftLoro, leftNode, pass)
      ) {
        // We need to refresh all the mappings under this node
        if (!Array.isArray(leftNode)) {
          updateLoroMap(leftLoro as LoroNode, leftNode as Node, mapping, pass);
        }
      } else {
        break;
      }
    }
  }

  // find number of matching elements from right
  for (; right + left < minLength; right++) {
    const rightLoro = loroChildren.get(loroChildLength - right - 1);
    const rightNode = nodeChildren[nodeChildLength - right - 1];
    if (rightLoro == null || rightNode == null) {
      break;
    }

    if (isContainer(rightLoro) && mapping.get(rightLoro.id) !== rightNode) {
      if (
        eqMappedNode(mapping.get(rightLoro.id), rightNode) ||
        eqLoroObjNode(rightLoro, rightNode, pass)
      ) {
        // We need to refresh all the mappings under this node
        if (!Array.isArray(rightNode)) {
          updateLoroMap(rightLoro as LoroNode, rightNode as Node, mapping, pass);
        }
      } else {
        break;
      }
    }
  }

  // Children pair by block id only under a parent that stays the same block (or the document).
  // A container rewritten in place as another block is not the same block: pairing its
  // children by id would delete the children that crossed, with a peer's text, so it pairs
  // by position as upstream does.
  const parentId = node.attrs.id ?? null;
  const keyed =
    node.type === node.type.schema.topNodeType ||
    (parentId !== null && getLoroMapAttributes(obj).get("id") === parentId);
  let loroKeys: ChildKey[] = [];
  let pmKeys: ChildKey[] = [];
  let paired = { loro: new Set<number>(), pm: new Set<number>() };
  if (keyed && loroChildLength - left - right > 0 && nodeChildLength - left - right > 0) {
    loroKeys = new Array(loroChildLength);
    for (let i = left; i < loroChildLength - right; i++) {
      loroKeys[i] = loroChildKey(loroChildren.get(i));
    }
    pmKeys = new Array(nodeChildLength);
    for (let j = left; j < nodeChildLength - right; j++) {
      pmKeys[j] = pmChildKey(nodeChildren[j]);
    }
    paired = pairByBlockId(
      loroKeys,
      pmKeys,
      left,
      loroChildLength - right,
      nodeChildLength - right,
      pass.movedIds,
    );
  }
  // `loroKeys` and `paired.loro` are by the Loro index when pairing ran; `loroShift` is how far
  // the deletes and inserts below have moved the live list from those indices.
  let loroShift = 0;
  const differentBlocks = (loroIndex: number, pmIndex: number) =>
    keyed &&
    loroKeys[loroIndex - loroShift]?.id != null &&
    pmKeys[pmIndex]?.id != null &&
    loroKeys[loroIndex - loroShift].id !== pmKeys[pmIndex].id;

  // try to compare and update
  while (loroChildLength - left - right > 0 && nodeChildLength - left - right > 0) {
    const leftLoro = loroChildren.get(left);
    const leftNode = nodeChildren[left];
    const rightLoro = loroChildren.get(loroChildLength - right - 1);
    const rightNode = nodeChildren[nodeChildLength - right - 1];

    if (leftLoro instanceof LoroText && Array.isArray(leftNode)) {
      if (!eqLoroTextNodes(leftLoro, leftNode, pass)) {
        updateLoroText(leftLoro, leftNode, mapping, pass);
      }
      left += 1;
    } else if (differentBlocks(left, left) && !paired.loro.has(left - loroShift)) {
      // An old block with no partner goes; the node at `left` is matched against what follows.
      if (isContainer(leftLoro)) mapping.delete(leftLoro.id);
      loroChildren.delete(left, 1);
      loroChildLength -= 1;
      loroShift -= 1;
    } else if (differentBlocks(left, left) && !paired.pm.has(left)) {
      // A new (or moved) block goes in before the old one, which waits for its own node.
      createLoroChild(loroChildren, left, leftNode, mapping);
      loroChildLength += 1;
      loroShift += 1;
      left += 1;
    } else {
      const rightLoroIndex = loroChildLength - right - 1;
      let updateLeft =
        leftLoro instanceof LoroMap &&
        eqNodeName(leftLoro, leftNode) &&
        !differentBlocks(left, left);
      let updateRight =
        rightLoro instanceof LoroMap &&
        eqNodeName(rightLoro, rightNode) &&
        !differentBlocks(rightLoroIndex, nodeChildLength - right - 1);

      if (updateLeft && updateRight) {
        // decide which which element to update
        const leftEquality = computeChildEqualityFactor(
          leftLoro as LoroNode,
          leftNode as Node,
          mapping,
          pass,
        );
        const rightEquality = computeChildEqualityFactor(
          rightLoro as LoroNode,
          rightNode as Node,
          mapping,
          pass,
        );

        if (leftEquality.foundMappedChild && !rightEquality.foundMappedChild) {
          updateRight = false;
        } else if (rightEquality.foundMappedChild && !leftEquality.foundMappedChild) {
          updateLeft = false;
        } else if (leftEquality.factor < rightEquality.factor) {
          updateLeft = false;
        } else {
          updateRight = false;
        }
      }

      if (updateLeft) {
        updateLoroMap(leftLoro as LoroNode, leftNode as Node, mapping, pass);
        left += 1;
      } else if (updateRight) {
        updateLoroMap(rightLoro as LoroNode, rightNode as Node, mapping, pass);
        right += 1;
      } else {
        // recreate the element at left
        const child = loroChildren.get(left);
        if (isContainer(child)) {
          mapping.delete(child.id);
        }
        loroChildren.delete(left, 1);
        createLoroChild(loroChildren, left, leftNode, mapping);
        left += 1;
      }
    }
  }

  const loroDelLength = loroChildLength - left - right;
  if (loroChildLength === 1 && nodeChildLength === 0 && loroChildren.get(0) instanceof LoroText) {
    // Only delete the content of the LoroText to retain remote changes on the same LoroText object
    // Otherwise, the LoroText object will be deleted and all the concurrent edits to the same LoroText object will be lost
    const loroText = loroChildren.get(0) as LoroText;
    mapping.delete(loroText.id);
    invalidateTextDelta(loroText, pass);
    loroText.delete(0, loroText.length);
  } else if (loroDelLength > 0) {
    loroChildren
      .toArray()
      .slice(left, left + loroDelLength)
      .filter(isContainer)
      .forEach((type) => {
        mapping.delete((type as LoroContainer).id);
      });
    loroChildren.delete(left, loroDelLength);
  }

  if (left + right < nodeChildLength) {
    nodeChildren.slice(left, nodeChildLength - right).forEach((nodeChild, i) => {
      createLoroChild(loroChildren, left + i, nodeChild, mapping);
    });
  }
}

function loroChildKey(child: unknown): ChildKey {
  if (!(child instanceof LoroMap)) return { id: null, name: null };
  const id = getLoroMapAttributes(child).get("id");
  const name = child.get(NODE_NAME_KEY);
  return {
    id: id == null ? null : String(id),
    name: typeof name === "string" ? name : null,
  };
}

function pmChildKey(child: Node | Node[]): ChildKey {
  if (Array.isArray(child)) return { id: null, name: null };
  const id = child.attrs.id;
  return { id: id == null ? null : String(id), name: child.type.name };
}

export function clearChangedNodes(
  doc: LoroDocType,
  event: LoroEventBatch,
  mapping: LoroNodeMapping,
) {
  for (const e of event.events) {
    const obj = doc.getContainerById(e.target);
    mapping.delete(obj!.id);

    let parentObj = obj!.parent();
    while (parentObj) {
      mapping.delete(parentObj!.id);
      parentObj = parentObj!.parent();
    }
  }
}

/**
 * Set a text selection between the given anchor and head positions. This
 * function will ignore out-of-bounds positions, and find a valid selection near
 * the given positions.
 */
export function safeSetSelection(view: EditorView, anchor: number, head?: number): void {
  const doc = view.state.doc;
  const docSize = doc.content.size;
  if (anchor < 0 || anchor > docSize || (head != null && (head < 0 || head > docSize))) {
    return;
  }

  const $anchor = doc.resolve(anchor);
  const $head = head != null ? doc.resolve(head) : undefined;

  const selection = TextSelection.between($anchor, $head || $anchor);
  view.dispatch(view.state.tr.setSelection(selection));
}
