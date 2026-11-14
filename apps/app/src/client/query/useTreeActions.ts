/** The writer's tree actions on one list (a project's, or the account's for `user://`). */
import { useMemo } from "react";
import { TreeActions } from "@/core/project-tree/tree-actions";
import { type TreeVersion, useTreeVersion } from "@/core/project-tree/tree-version";
import { useAccountId } from "@/features/project/context/account-feature-context";
import { useTreeList } from "./useProjectTree";

/**
 * A project list with no project id (a surface outside any project) takes no action: each answers
 * `no-list`. The actions act in the shell's Live/Draft version unless the caller names one.
 */
export function useTreeActions(
  list: { kind: "project"; projectId: string | null } | { kind: "account" },
  version?: TreeVersion,
): TreeActions {
  const shown = useTreeVersion();
  const acting = version ?? shown;
  const accountId = useAccountId();
  const ref = useMemo(
    () =>
      list.kind === "project"
        ? list.projectId
          ? ({ kind: "project", projectId: list.projectId } as const)
          : null
        : ({ kind: "account", userId: accountId } as const),
    [list.kind, accountId, list.kind === "project" ? list.projectId : null],
  );
  const { session } = useTreeList(ref);
  return useMemo(
    () =>
      new TreeActions(
        () => session,
        `user:${accountId}`,
        () => acting,
      ),
    [session, accountId, acting],
  );
}
