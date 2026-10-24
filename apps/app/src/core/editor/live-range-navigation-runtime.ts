/** Active destination editors used by passage and change-trail navigation. */
import type { Editor } from "@tiptap/core";
import type * as Y from "yjs";
import type { DocumentSession } from "./document-session";
import { relativeRangeToEditorPositions } from "./extensions/LiveRangeNavigationExtension";
import { resolvePassage } from "./passage-resolution";

export type LiveEditorContainer = "editor" | "dock";
export type LiveEditorTarget = {
  editor: Editor;
  session: DocumentSession;
  localContentReady: boolean;
  container: LiveEditorContainer;
  /** Registration lifetime. Retirement revokes every capability on this target. */
  signal: AbortSignal;
};

type LiveEditorRegistration = Omit<LiveEditorTarget, "signal">;

const targets = new Map<string, Map<LiveEditorContainer, LiveEditorTarget>>();
const listeners = new Map<string, Set<() => void>>();

function targetKey(documentId: string, container: LiveEditorContainer): string {
  return `${documentId}:${container}`;
}

export function registerLiveRangeEditor(
  documentId: string,
  registration: LiveEditorRegistration,
): () => void {
  const documentTargets = targets.get(documentId) ?? new Map();
  const prior = documentTargets.get(registration.container);
  const lifetime = new AbortController();
  const target: LiveEditorTarget = { ...registration, signal: lifetime.signal };
  retirements.set(target, lifetime);
  if (prior) retireTarget(prior);
  documentTargets.set(target.container, target);
  targets.set(documentId, documentTargets);
  const key = targetKey(documentId, target.container);
  for (const listener of listeners.get(key) ?? []) listener();
  return () => {
    const current = targets.get(documentId);
    if (current?.get(target.container) === target) current.delete(target.container);
    retireTarget(target);
    if (current?.size === 0) targets.delete(documentId);
    for (const listener of listeners.get(key) ?? []) listener();
  };
}

const retirements = new WeakMap<LiveEditorTarget, AbortController>();

function retireTarget(target: LiveEditorTarget): void {
  retirements.get(target)?.abort();
  retirements.delete(target);
}

export async function whenLiveEditor(
  documentId: string,
  container: LiveEditorContainer,
  signal?: AbortSignal,
): Promise<LiveEditorTarget | null> {
  const current = targets.get(documentId)?.get(container);
  if (current && !current.editor.isDestroyed) return current;
  if (signal?.aborted) return null;
  const key = targetKey(documentId, container);
  return new Promise((resolve) => {
    const settle = () => {
      const target = targets.get(documentId)?.get(container);
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

export function showLiveRangeInTarget(
  target: LiveEditorTarget,
  range: { start: Y.RelativePosition; end: Y.RelativePosition },
  boundary = false,
): { shown: boolean } {
  if (target.signal.aborted || target.editor.isDestroyed) return { shown: false };
  const positions = relativeRangeToEditorPositions(target.editor, range);
  if (!positions) return { shown: false };
  const shown = boundary
    ? target.editor.commands.showLivePosition(range.start)
    : target.editor.commands.showLiveRange(range);
  return { shown };
}

export function showPassageInTarget(
  target: LiveEditorTarget,
  passage: {
    block: { start: Y.RelativePosition; end: Y.RelativePosition } | null;
    term: string;
  },
): { outcome: "landed" | "stale" } | null {
  if (target.signal.aborted || target.editor.isDestroyed) return null;
  const blockRange = passage.block
    ? relativeRangeToEditorPositions(target.editor, passage.block)
    : null;
  if (passage.block && !blockRange) return null;
  const resolution = resolvePassage(target.editor.state.doc, blockRange, passage.term);
  if (resolution.kind === "stale") return { outcome: "stale" };
  return target.editor.commands.showPassageMatches(resolution.ranges)
    ? { outcome: "landed" }
    : null;
}

export function showPeerMarkerInTarget(
  target: LiveEditorTarget,
  changeId: string,
): { shown: boolean } {
  return {
    shown:
      !target.signal.aborted &&
      !target.editor.isDestroyed &&
      target.editor.commands.showPeerMarker(changeId),
  };
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
