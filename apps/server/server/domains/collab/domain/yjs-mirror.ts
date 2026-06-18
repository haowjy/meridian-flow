import { PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import type { Node as PMNode } from "prosemirror-model";
import {
  prosemirrorToYXmlFragment,
  updateYFragment,
  yXmlFragmentToProseMirrorRootNode,
} from "y-prosemirror";
import * as Y from "yjs";
import type { SchemaType, UpdateOrigin } from "../ports/document-sync.js";
import { buildFragmentCache, type FragmentCache } from "./fragment-cache.js";
import { getSchema, mdxToNode, nodeToMdx } from "./schemas.js";

export interface MirrorEntry {
  doc: Y.Doc;
  fragmentName: string;
  filetype: string;
  schemaType: SchemaType;
  cache: FragmentCache;
}

export class YjsDecodeError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "YjsDecodeError";
  }
}

function applyBytes(doc: Y.Doc, update: Uint8Array, origin?: UpdateOrigin): void {
  try {
    Y.applyUpdate(doc, update, origin);
  } catch (cause) {
    throw new YjsDecodeError(cause);
  }
}

function fragmentOf(doc: Y.Doc): Y.XmlFragment {
  return doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
}

function rootOf(doc: Y.Doc, schemaType: SchemaType): PMNode {
  return yXmlFragmentToProseMirrorRootNode(fragmentOf(doc), getSchema(schemaType));
}

function refreshCache(entry: MirrorEntry): void {
  entry.cache = buildFragmentCache(rootOf(entry.doc, entry.schemaType), entry.schemaType);
}

function schemaTypeForFiletype(filetype: string): SchemaType {
  return filetype === "markdown" ? "document" : "code";
}

export function createMirror(initialContent: string, filetype: string): MirrorEntry {
  const schemaType = schemaTypeForFiletype(filetype);
  const doc = new Y.Doc();
  const node = mdxToNode(schemaType, initialContent);
  prosemirrorToYXmlFragment(node, fragmentOf(doc));
  return {
    doc,
    fragmentName: PROSEMIRROR_FRAGMENT_NAME,
    filetype,
    schemaType,
    cache: buildFragmentCache(node, schemaType),
  };
}

export function rebuildMirror(
  filetype: string,
  checkpointState: Uint8Array | null,
  updates: Uint8Array[],
): MirrorEntry {
  const schemaType = schemaTypeForFiletype(filetype);
  const doc = new Y.Doc();
  if (checkpointState) {
    applyBytes(doc, checkpointState);
  }
  for (const update of updates) {
    applyBytes(doc, update);
  }
  const entry: MirrorEntry = {
    doc,
    fragmentName: PROSEMIRROR_FRAGMENT_NAME,
    filetype,
    schemaType,
    cache: buildFragmentCache(rootOf(doc, schemaType), schemaType),
  };
  return entry;
}

export function cloneMirror(entry: MirrorEntry): MirrorEntry {
  return rebuildMirror(entry.filetype, encodeState(entry), []);
}

export function readAsMarkdown(entry: MirrorEntry): string {
  return entry.cache.fullMarkdown;
}

export function setDocumentToMarkdown(
  entry: MirrorEntry,
  targetMarkdown: string,
  origin: UpdateOrigin,
): Uint8Array | null {
  const target = mdxToNode(entry.schemaType, targetMarkdown);
  const before = Y.encodeStateVector(entry.doc);
  entry.doc.transact(() => {
    updateYFragment(entry.doc, fragmentOf(entry.doc), target, {
      mapping: new Map(),
      isOMark: new Map(),
    });
  }, origin);
  const update = Y.encodeStateAsUpdate(entry.doc, before);
  refreshCache(entry);
  return update.length > 0 ? update : null;
}

export function applyRemoteUpdate(
  entry: MirrorEntry,
  update: Uint8Array,
  origin: UpdateOrigin,
): Uint8Array | null {
  const before = Y.encodeStateVector(entry.doc);
  applyBytes(entry.doc, update, origin);
  const effectiveUpdate = Y.encodeStateAsUpdate(entry.doc, before);
  refreshCache(entry);
  return effectiveUpdate.length > 0 ? effectiveUpdate : null;
}

export function markdownFromState(schemaType: SchemaType, state: Uint8Array): string {
  const doc = new Y.Doc();
  applyBytes(doc, state);
  return nodeToMdx(schemaType, rootOf(doc, schemaType));
}

export function encodeState(entry: MirrorEntry): Uint8Array {
  return Y.encodeStateAsUpdate(entry.doc);
}

export function encodeStateVector(entry: MirrorEntry): Uint8Array {
  return Y.encodeStateVector(entry.doc);
}

export function originColumns(origin: UpdateOrigin): {
  originType: string;
  actorUserId: string | null;
  actorAgentRunId: string | null;
  actorTurnId: string | null;
} {
  switch (origin.type) {
    case "user":
      return {
        originType: "user",
        actorUserId: origin.userId,
        actorAgentRunId: null,
        actorTurnId: null,
      };
    case "agent":
      return {
        originType: "agent",
        actorUserId: null,
        actorAgentRunId: null,
        actorTurnId: origin.actorTurnId,
      };
    case "import":
      return {
        originType: "import",
        actorUserId: origin.userId,
        actorAgentRunId: null,
        actorTurnId: null,
      };
    case "system":
      return { originType: "system", actorUserId: null, actorAgentRunId: null, actorTurnId: null };
  }
}
