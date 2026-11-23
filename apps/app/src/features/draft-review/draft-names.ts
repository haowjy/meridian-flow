import { t } from "@lingui/core/macro";
import type { WorkDraft } from "@meridian/contracts/drafts";

/** A Work's draft as the writer reads it: its name, or for an unnamed one what it is. */
export function workDraftName(draft: Pick<WorkDraft, "name" | "isDefault">): string {
  return draft.name ?? (draft.isDefault ? t`Main draft` : t`Untitled draft`);
}

/** The name `+ New draft` gives: "Draft 2", the first number no draft of the Work has. */
export function nextDraftName(drafts: readonly Pick<WorkDraft, "name">[]): string {
  const taken = new Set(drafts.map((draft) => draft.name));
  for (let n = drafts.length + 1; ; n++) {
    const name = t`Draft ${n}`;
    if (!taken.has(name)) return name;
  }
}
