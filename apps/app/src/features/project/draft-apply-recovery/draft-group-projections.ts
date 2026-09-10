/** Pure server-active and command-eligible projections over draft list truth. */
import type { ThreadDraftGroup } from "@/client/query/useWorkDrafts";
import type { PostApplySnapshot } from "./draft-apply-recovery-owner";

export type DraftGroupProjections = {
  serverActiveGroups: ThreadDraftGroup[] | null;
  commandEligibleGroups: ThreadDraftGroup[] | null;
};

export function projectPostApplyDraftGroups(
  groups: readonly ThreadDraftGroup[] | null,
  snapshot: PostApplySnapshot,
  accountId: string | null,
  projectId: string,
  workId: string,
): DraftGroupProjections {
  if (!groups) return { serverActiveGroups: null, commandEligibleGroups: null };
  const matches = (
    draft: ThreadDraftGroup["drafts"][number],
    identity: {
      accountId: string;
      projectId: string;
      workId: string;
      documentId: string;
      draftId: string;
    },
  ) =>
    identity.accountId === accountId &&
    identity.projectId === projectId &&
    identity.workId === workId &&
    identity.documentId === draft.documentId &&
    identity.draftId === draft.draftId;
  const filter = (excluded: (draft: ThreadDraftGroup["drafts"][number]) => boolean) =>
    groups.flatMap((group) => {
      const drafts = group.drafts.filter((draft) => !excluded(draft));
      return drafts.length > 0 ? [{ ...group, drafts }] : [];
    });
  const serverActiveGroups = filter(
    (draft) =>
      snapshot.items.some((item) => matches(draft, item.identity)) ||
      snapshot.appliedSuppressions.some((item) => matches(draft, item.identity)),
  );
  const commandEligibleGroups = filter(
    (draft) =>
      snapshot.items.some((item) => matches(draft, item.identity)) ||
      snapshot.appliedSuppressions.some((item) => matches(draft, item.identity)) ||
      snapshot.reservations.some((item) => matches(draft, item.identity)),
  );
  return { serverActiveGroups, commandEligibleGroups };
}
