import { t } from "@lingui/core/macro";
import type { WorkDraft } from "@meridian/contracts/drafts";

export function workDraftName(draft: Pick<WorkDraft, "name" | "isDefault">): string {
  return draft.name ?? (draft.isDefault ? t`Main draft` : t`Untitled draft`);
}

export function nextDraftName(drafts: readonly Pick<WorkDraft, "name">[]): string {
  const taken = new Set(drafts.map((draft) => draft.name));
  for (let n = drafts.length + 1; ; n++) {
    const name = t`Draft ${n}`;
    if (!taken.has(name)) return name;
  }
}
