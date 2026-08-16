/** One-shot focus continuity between route-owned Work detail and collection renders. */
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
