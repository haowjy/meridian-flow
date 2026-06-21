// Live UndoManager registry for hot-path per-thread reversal.
import { PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import * as Y from "yjs";

import { shouldDeleteUndoItem, type UndoStackItemLike } from "./delete-filter.js";

const TURN_ID_META = "turnId";
const THREAD_ID_META = "threadId";
const DOC_ID_META = "docId";

type UndoStackItemEvent = {
  stackItem: UndoStackItemLike;
  origin: unknown;
  type: "undo" | "redo";
};

export interface UndoManagerRegistryOptions {
  /** XmlFragment name that backs the ProseMirror document. */
  fragmentName?: string;
  /** Destroy the hot manager when live undo depth exceeds this cap; cold path remains authoritative. */
  undoDepthCap?: number;
  now?: () => number;
}

export interface LiveThreadUndoManager {
  docId: string;
  threadId: string;
  origin: symbol;
  undoManager: Y.UndoManager;
  undoDepth: number;
  redoDepth: number;
}

export interface UndoStackMetadata {
  turnId?: string;
  docId?: string;
  threadId?: string;
}

export interface LiveThreadUndoState {
  docId: string;
  threadId: string;
  activeTurnId?: string;
  undoStack: UndoStackMetadata[];
  redoStack: UndoStackMetadata[];
  fallback?: {
    reason: "undo_depth_cap";
    undoDepth: number;
    cap: number;
  };
}

export type HotUndoAddress =
  | { scope: "file"; mutationClientId?: number }
  | { scope: "turn"; turnId?: string; mutationClientId?: number };

export interface HotRedoOptions {
  mutationClientId?: number;
}

export type HotUndoResult =
  | {
      ok: true;
      status: "undone";
      docId: string;
      threadId: string;
      turnId?: string;
      undoDepth: number;
      redoDepth: number;
    }
  | {
      ok: false;
      status: "no_manager" | "no_undo" | "turn_not_on_top";
      docId: string;
      threadId: string;
      expectedTurnId?: string;
      actualTurnId?: string;
    };

export type HotRedoResult =
  | {
      ok: true;
      status: "redone";
      docId: string;
      threadId: string;
      turnId?: string;
      undoDepth: number;
      redoDepth: number;
    }
  | { ok: false; status: "no_manager" | "no_redo"; docId: string; threadId: string };

interface LiveEntry {
  docId: string;
  threadId: string;
  doc: Y.Doc;
  origin: symbol;
  undoManager: Y.UndoManager;
  activeTurnId?: string;
  lastUsedAt: number;
  currentDeleteFilterStackItem: UndoStackItemLike | null;
  pendingDestroy?: LiveThreadUndoState["fallback"];
}

/** Registry keyed by (docId, threadId), with stable Symbol origins per key. */
export class UndoManagerRegistry {
  private readonly fragmentName: string;
  private readonly undoDepthCap: number;
  private readonly now: () => number;
  private readonly origins = new Map<string, symbol>();
  private readonly entries = new Map<string, LiveEntry>();

  constructor(options: UndoManagerRegistryOptions = {}) {
    this.fragmentName = options.fragmentName ?? PROSEMIRROR_FRAGMENT_NAME;
    this.undoDepthCap = options.undoDepthCap ?? Number.POSITIVE_INFINITY;
    this.now = options.now ?? Date.now;
  }

  /** Stable transaction origin for this thread. Create the live UM before using it for edits. */
  getThreadOrigin(docId: string, threadId: string): symbol {
    const key = registryKey(docId, threadId);
    let origin = this.origins.get(key);
    if (!origin) {
      origin = Symbol(`thread-${threadId}`);
      this.origins.set(key, origin);
    }
    return origin;
  }

  getOrCreate(docId: string, threadId: string, doc: Y.Doc): LiveThreadUndoManager {
    const key = registryKey(docId, threadId);
    const existing = this.entries.get(key);
    if (existing?.doc === doc) {
      existing.lastUsedAt = this.now();
      return publicEntry(existing);
    }
    if (existing) this.destroyEntry(key, existing, { keepOrigin: true });

    const origin = this.getThreadOrigin(docId, threadId);
    const fragment = doc.getXmlFragment(this.fragmentName);
    const entry: LiveEntry = {
      docId,
      threadId,
      doc,
      origin,
      undoManager: undefined as unknown as Y.UndoManager,
      lastUsedAt: this.now(),
      currentDeleteFilterStackItem: null,
    };
    entry.undoManager = new Y.UndoManager(fragment, {
      trackedOrigins: new Set([origin]),
      captureTimeout: Number.POSITIVE_INFINITY,
      deleteFilter: (item) => shouldDeleteUndoItem(item, entry.currentDeleteFilterStackItem),
    });
    entry.undoManager.on("stack-item-added", (event: UndoStackItemEvent) => {
      this.onStackItemAdded(entry, event);
    });
    entry.undoManager.on("stack-item-updated", (event: UndoStackItemEvent) => {
      this.onStackItemUpdated(entry, event);
    });
    this.entries.set(key, entry);
    return publicEntry(entry);
  }

  beginTurn(docId: string, threadId: string, doc: Y.Doc, turnId: string): LiveThreadUndoManager {
    const entry = this.requireLiveEntry(docId, threadId, doc);
    if (entry.activeTurnId && entry.activeTurnId !== turnId) {
      throw new Error(
        `Cannot begin turn ${turnId}; turn ${entry.activeTurnId} is still active for ${docId}/${threadId}`,
      );
    }
    entry.activeTurnId = turnId;
    entry.lastUsedAt = this.now();
    entry.undoManager.stopCapturing();
    return publicEntry(entry);
  }

  endTurn(docId: string, threadId: string, turnId?: string): LiveThreadUndoState {
    const entry = this.entries.get(registryKey(docId, threadId));
    if (!entry) throw new Error(`No UndoManager for ${docId}/${threadId}`);
    if (turnId && entry.activeTurnId && entry.activeTurnId !== turnId) {
      throw new Error(
        `Cannot end turn ${turnId}; active turn is ${entry.activeTurnId} for ${docId}/${threadId}`,
      );
    }
    entry.undoManager.stopCapturing();
    entry.activeTurnId = undefined;
    entry.lastUsedAt = this.now();
    const state = stateForEntry(entry);
    if (entry.pendingDestroy) {
      const key = registryKey(docId, threadId);
      this.destroyEntry(key, entry, { keepOrigin: true });
    }
    return state;
  }

  undoLatest(
    docId: string,
    threadId: string,
    address: HotUndoAddress = { scope: "file" },
  ): HotUndoResult {
    const entry = this.entries.get(registryKey(docId, threadId));
    if (!entry) return { ok: false, status: "no_manager", docId, threadId };
    const stackItem = entry.undoManager.undoStack.at(-1) ?? null;
    if (!stackItem) return { ok: false, status: "no_undo", docId, threadId };
    const actualTurnId = stackMetadata(stackItem).turnId;
    if (address.scope === "turn" && address.turnId && actualTurnId !== address.turnId) {
      return {
        ok: false,
        status: "turn_not_on_top",
        docId,
        threadId,
        expectedTurnId: address.turnId,
        actualTurnId,
      };
    }

    setMutationClientId(entry.doc, address.mutationClientId);
    entry.undoManager.stopCapturing();
    entry.currentDeleteFilterStackItem = stackItem;
    let popped: UndoStackItemLike | null;
    try {
      popped = entry.undoManager.undo();
    } finally {
      entry.currentDeleteFilterStackItem = null;
      entry.undoManager.stopCapturing();
    }
    if (!popped) return { ok: false, status: "no_undo", docId, threadId };
    entry.lastUsedAt = this.now();
    return {
      ok: true,
      status: "undone",
      docId,
      threadId,
      turnId: stackMetadata(popped).turnId,
      undoDepth: entry.undoManager.undoStack.length,
      redoDepth: entry.undoManager.redoStack.length,
    };
  }

  redoLatest(docId: string, threadId: string, options: HotRedoOptions = {}): HotRedoResult {
    const entry = this.entries.get(registryKey(docId, threadId));
    if (!entry) return { ok: false, status: "no_manager", docId, threadId };
    const stackItem = entry.undoManager.redoStack.at(-1) ?? null;
    if (!stackItem) return { ok: false, status: "no_redo", docId, threadId };

    setMutationClientId(entry.doc, options.mutationClientId);
    entry.undoManager.stopCapturing();
    entry.currentDeleteFilterStackItem = stackItem;
    let popped: UndoStackItemLike | null;
    try {
      popped = entry.undoManager.redo();
    } finally {
      entry.currentDeleteFilterStackItem = null;
      entry.undoManager.stopCapturing();
    }
    if (!popped) return { ok: false, status: "no_redo", docId, threadId };
    entry.lastUsedAt = this.now();
    return {
      ok: true,
      status: "redone",
      docId,
      threadId,
      turnId: stackMetadata(popped).turnId,
      undoDepth: entry.undoManager.undoStack.length,
      redoDepth: entry.undoManager.redoStack.length,
    };
  }

  getState(docId: string, threadId: string): LiveThreadUndoState | null {
    const entry = this.entries.get(registryKey(docId, threadId));
    if (!entry) return null;
    return stateForEntry(entry);
  }

  hasActiveDocument(docId: string): boolean {
    for (const entry of this.entries.values()) if (entry.docId === docId) return true;
    return false;
  }

  evictDocument(docId: string): number {
    let evicted = 0;
    for (const [key, entry] of [...this.entries]) {
      if (entry.docId !== docId) continue;
      this.destroyEntry(key, entry, { keepOrigin: false });
      evicted += 1;
    }
    for (const key of [...this.origins.keys()])
      if (key.startsWith(`${docId}\u0000`)) this.origins.delete(key);
    return evicted;
  }

  evictThread(docId: string, threadId: string): boolean {
    const key = registryKey(docId, threadId);
    const entry = this.entries.get(key);
    if (entry) this.destroyEntry(key, entry, { keepOrigin: false });
    this.origins.delete(key);
    return Boolean(entry);
  }

  evictIdle(olderThanMs: number): number {
    const cutoff = this.now() - olderThanMs;
    let evicted = 0;
    for (const [key, entry] of [...this.entries]) {
      if (entry.lastUsedAt >= cutoff) continue;
      this.destroyEntry(key, entry, { keepOrigin: false });
      this.origins.delete(key);
      evicted += 1;
    }
    return evicted;
  }

  private requireLiveEntry(docId: string, threadId: string, doc: Y.Doc): LiveEntry {
    this.getOrCreate(docId, threadId, doc);
    return this.entries.get(registryKey(docId, threadId)) as LiveEntry;
  }

  private onStackItemAdded(entry: LiveEntry, event: UndoStackItemEvent): void {
    if (event.type === "undo" && event.origin === entry.undoManager) {
      writeMetadata(
        event.stackItem,
        stackMetadata(entry.currentDeleteFilterStackItem ?? event.stackItem),
      );
      return;
    }
    if (event.type === "redo") {
      writeMetadata(
        event.stackItem,
        stackMetadata(entry.currentDeleteFilterStackItem ?? event.stackItem),
      );
      return;
    }
    if (event.type !== "undo") return;
    if (entry.activeTurnId === undefined) {
      throw new Error(
        `UndoManager captured ${entry.docId}/${entry.threadId} outside beginTurn/endTurn`,
      );
    }
    writeMetadata(event.stackItem, {
      docId: entry.docId,
      threadId: entry.threadId,
      turnId: entry.activeTurnId,
    });
    this.enforceUndoDepthCap(entry);
  }

  private onStackItemUpdated(entry: LiveEntry, event: UndoStackItemEvent): void {
    if (event.type !== "undo" || event.origin === entry.undoManager) return;
    const meta = stackMetadata(event.stackItem);
    if (meta.turnId && entry.activeTurnId && meta.turnId !== entry.activeTurnId) {
      throw new Error(
        `UndoManager merged turn ${entry.activeTurnId} into ${meta.turnId}; missing stopCapturing boundary`,
      );
    }
    if (!meta.turnId && entry.activeTurnId) {
      writeMetadata(event.stackItem, {
        docId: entry.docId,
        threadId: entry.threadId,
        turnId: entry.activeTurnId,
      });
    }
  }

  private enforceUndoDepthCap(entry: LiveEntry): void {
    if (entry.undoManager.undoStack.length <= this.undoDepthCap) return;
    entry.pendingDestroy = {
      reason: "undo_depth_cap",
      undoDepth: entry.undoManager.undoStack.length,
      cap: this.undoDepthCap,
    };
  }

  private destroyEntry(key: string, entry: LiveEntry, options: { keepOrigin: boolean }): void {
    entry.undoManager.destroy();
    this.entries.delete(key);
    if (!options.keepOrigin) this.origins.delete(key);
  }
}

export function createUndoManagerRegistry(
  options: UndoManagerRegistryOptions = {},
): UndoManagerRegistry {
  return new UndoManagerRegistry(options);
}

// Hot/cold byte parity requires both paths to mint undo Items under the same fresh clientID.
function setMutationClientId(doc: Y.Doc, clientId: number | undefined): void {
  if (clientId === undefined || doc.clientID === clientId) return;
  const store = doc as unknown as { store?: { clients?: Map<number, unknown> } };
  if (store.store?.clients?.has(clientId)) {
    throw new Error(
      `Cannot use Yjs clientID ${clientId} for undo; it already exists in the document store`,
    );
  }
  doc.clientID = clientId;
}

function publicEntry(entry: LiveEntry): LiveThreadUndoManager {
  return {
    docId: entry.docId,
    threadId: entry.threadId,
    origin: entry.origin,
    undoManager: entry.undoManager,
    undoDepth: entry.undoManager.undoStack.length,
    redoDepth: entry.undoManager.redoStack.length,
  };
}

function stateForEntry(entry: LiveEntry): LiveThreadUndoState {
  return {
    docId: entry.docId,
    threadId: entry.threadId,
    activeTurnId: entry.activeTurnId,
    undoStack: entry.undoManager.undoStack.map(stackMetadata),
    redoStack: entry.undoManager.redoStack.map(stackMetadata),
    fallback: entry.pendingDestroy,
  };
}

function writeMetadata(stackItem: UndoStackItemLike, metadata: UndoStackMetadata): void {
  if (metadata.turnId !== undefined) stackItem.meta.set(TURN_ID_META, metadata.turnId);
  if (metadata.threadId !== undefined) stackItem.meta.set(THREAD_ID_META, metadata.threadId);
  if (metadata.docId !== undefined) stackItem.meta.set(DOC_ID_META, metadata.docId);
}

function stackMetadata(stackItem: UndoStackItemLike): UndoStackMetadata {
  return {
    turnId: stringMeta(stackItem.meta.get(TURN_ID_META)),
    threadId: stringMeta(stackItem.meta.get(THREAD_ID_META)),
    docId: stringMeta(stackItem.meta.get(DOC_ID_META)),
  };
}

function stringMeta(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function registryKey(docId: string, threadId: string): string {
  return `${docId}\u0000${threadId}`;
}
