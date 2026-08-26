/** One-shot focus continuity between route-owned Work detail and collection renders. */
import type { Work } from "@meridian/contracts/works";

export type WorkCollectionFocusIntent =
  | { kind: "heading" }
  | { kind: "new-work" }
  | { kind: "work"; workId: string };

const intents = new Map<string, WorkCollectionFocusIntent>();

export function holdWorkCollectionFocus(projectId: string, intent: WorkCollectionFocusIntent) {
  intents.set(projectId, intent);
}

export function takeWorkCollectionFocus(projectId: string): WorkCollectionFocusIntent | null {
  const intent = intents.get(projectId) ?? null;
  intents.delete(projectId);
  return intent;
}

export function focusAfterDelete(works: Work[], deletedId: string): WorkCollectionFocusIntent {
  const deleted = works.find((work) => work.id === deletedId);
  if (!deleted) return { kind: "new-work" };
  const peers = works.filter((work) => work.status === deleted.status);
  const index = peers.findIndex((work) => work.id === deletedId);
  const sibling = peers[index + 1] ?? peers[index - 1];
  return sibling ? { kind: "work", workId: sibling.id } : { kind: "new-work" };
}
