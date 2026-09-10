/** Reactive authenticated-account projection for post-Apply disposition data. */

import { createContext, type ReactNode, useContext, useSyncExternalStore } from "react";
import type { ThreadDraftGroup } from "@/client/query/useWorkDrafts";
import { useAccountPostApplyDispositionOwner } from "../context/account-feature-context";
import type { PostApplyDispositionOwner, PostApplySnapshot } from "./draft-apply-recovery-owner";
import { type DraftGroupProjections, projectPostApplyDraftGroups } from "./draft-group-projections";

const PostApplyDispositionContext = createContext<{
  accountId: string;
  owner: PostApplyDispositionOwner;
} | null>(null);
const EMPTY_SNAPSHOT: PostApplySnapshot = {
  nextVersion: 1,
  reservations: [],
  items: [],
  appliedSuppressions: [],
  remoteDraftWitnesses: [],
};

export function DraftApplyRecoveryProvider({
  accountId,
  children,
}: {
  accountId: string;
  children: ReactNode;
}) {
  const owner = useAccountPostApplyDispositionOwner();
  return (
    <PostApplyDispositionContext.Provider value={{ accountId, owner }}>
      {children}
    </PostApplyDispositionContext.Provider>
  );
}

export function usePostApplyDispositionOwner(): PostApplyDispositionOwner {
  const value = useContext(PostApplyDispositionContext);
  if (!value) throw new Error("DraftApplyRecoveryProvider is required");
  return value.owner;
}

export function usePostApplyAccountId(): string {
  const value = useContext(PostApplyDispositionContext);
  if (!value) throw new Error("DraftApplyRecoveryProvider is required");
  return value.accountId;
}

export function usePostApplySnapshot(): PostApplySnapshot {
  const owner = usePostApplyDispositionOwner();
  return useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);
}

export function useOptionalPostApplyDisposition(): {
  accountId: string;
  owner: PostApplyDispositionOwner;
} | null {
  return useContext(PostApplyDispositionContext);
}

export function usePostApplyDraftGroupProjections(
  groups: readonly ThreadDraftGroup[] | null,
  projectId: string,
  workId: string,
): DraftGroupProjections {
  const disposition = useOptionalPostApplyDisposition();
  const snapshot = useSyncExternalStore(
    disposition?.owner.subscribe ?? (() => () => undefined),
    disposition?.owner.getSnapshot ?? (() => EMPTY_SNAPSHOT),
    disposition?.owner.getSnapshot ?? (() => EMPTY_SNAPSHOT),
  );
  return projectPostApplyDraftGroups(
    groups,
    snapshot,
    disposition?.accountId ?? null,
    projectId,
    workId,
  );
}
