import { fullHashForBlockId } from "@meridian/agent-edit";
import type { Editor } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import type { DocumentSession } from "./document-session";
import { resolvePassage, type TextRange } from "./passage-resolution";

export type LiveEditorTarget = {
  editor: Editor;
  session: DocumentSession;
  localContentReady: boolean;
  signal: AbortSignal;
};

type LiveEditorRegistration = Omit<LiveEditorTarget, "signal">;

const targets = new Map<string, LiveEditorTarget>();
const listeners = new Map<string, Set<() => void>>();

export function registerLiveRangeEditor(
  documentId: string,
  registration: LiveEditorRegistration,
): () => void {
  const prior = targets.get(documentId);
  const lifetime = new AbortController();
  const target: LiveEditorTarget = { ...registration, signal: lifetime.signal };
  retirements.set(target, lifetime);
  if (prior) retireTarget(prior);
  targets.set(documentId, target);
  for (const listener of listeners.get(documentId) ?? []) listener();
  return () => {
    if (targets.get(documentId) === target) targets.delete(documentId);
    retireTarget(target);
    for (const listener of listeners.get(documentId) ?? []) listener();
  };
}

const retirements = new WeakMap<LiveEditorTarget, AbortController>();

function retireTarget(target: LiveEditorTarget): void {
  retirements.get(target)?.abort();
  retirements.delete(target);
}

export async function whenLiveEditor(
  documentId: string,
  signal?: AbortSignal,
): Promise<LiveEditorTarget | null> {
  const current = targets.get(documentId);
  if (current && !current.editor.isDestroyed) return current;
  if (signal?.aborted) return null;
  const key = documentId;
  return new Promise((resolve) => {
    const settle = () => {
      const target = targets.get(documentId);
      if (!target || target.editor.isDestroyed) return;
      cleanup();
      resolve(target);
    };
    const abort = () => {
      cleanup();
      resolve(null);
    };
    const cleanup = () => {
      signal?.removeEventListener("abort", abort);
      const currentListeners = listeners.get(key);
      currentListeners?.delete(settle);
      if (currentListeners?.size === 0) listeners.delete(key);
    };
    const currentListeners = listeners.get(key) ?? new Set();
    currentListeners.add(settle);
    listeners.set(key, currentListeners);
    signal?.addEventListener("abort", abort, { once: true });
    settle();
  });
}

export function showPassageInTarget(
  target: LiveEditorTarget,
  passage: { blockHash: string; term: string },
): { outcome: "landed" | "stale" } | null {
  if (target.signal.aborted || target.editor.isDestroyed) return null;
  const { doc } = target.editor.state;
  const resolution = resolvePassage(doc, blockRangeForHash(doc, passage.blockHash), passage.term);
  if (resolution.kind === "stale") return { outcome: "stale" };
  return target.editor.commands.showPassageMatches(resolution.ranges)
    ? { outcome: "landed" }
    : null;
}

/**
 * The span of the block a search hit's hash names: the hash is a prefix of the full hash of the
 * block's `id`. Null when it names none, or more than one: two candidate blocks cannot promise one
 * passage, and picking either is the guess this feature refuses to make.
 */
function blockRangeForHash(doc: Node, hash: string): TextRange | null {
  const prefix = hash.trim().toLowerCase();
  if (!prefix) return null;
  let found: TextRange | null = null;
  let matches = 0;
  doc.descendants((node, pos) => {
    if (matches > 1) return false;
    const id = node.attrs.id;
    if (typeof id === "string" && fullHashForBlockId(id).startsWith(prefix)) {
      matches += 1;
      found = { from: pos, to: pos + node.nodeSize };
    }
    return !node.isTextblock;
  });
  return matches === 1 ? found : null;
}

export function waitForLiveRangeRetry(signal: AbortSignal, delayMs = 25): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timeout = setTimeout(finish, delayMs);
    signal.addEventListener("abort", finish, { once: true });
  });
}
