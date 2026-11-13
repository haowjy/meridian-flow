/** The writer's tree actions on one list (a project's, or the account's for `user://`). */
import { useMemo } from "react";
import { TreeActions } from "@/core/project-tree/tree-actions";
import { useAccountId } from "@/features/project/context/account-feature-context";
import { useTreeList } from "./useProjectTree";

export function useTreeActions(
  list: { kind: "project"; projectId: string } | { kind: "account" },
): TreeActions {
  const accountId = useAccountId();
  const ref = useMemo(
    () =>
      list.kind === "project"
        ? ({ kind: "project", projectId: list.projectId } as const)
        : ({ kind: "account", userId: accountId } as const),
    [list.kind, accountId, list.kind === "project" ? list.projectId : null],
  );
  const { session } = useTreeList(ref);
  return useMemo(() => new TreeActions(() => session, `user:${accountId}`), [session, accountId]);
}
