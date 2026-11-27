import { userActor } from "@meridian/project-tree";
import { useMemo } from "react";
import { TreeActions } from "@/core/project-tree/tree-actions";
import { type TreeVersion, useTreeVersion } from "@/core/project-tree/tree-version";
import { useAccountId } from "@/features/project/context/account-feature-context";
import { useClosedOwners } from "@/features/project/context/closed-owners";
import { useTreeList } from "./useProjectTree";

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
  const closed = useClosedOwners(list.kind === "project" ? (list.projectId ?? "") : "");
  return useMemo(
    () =>
      new TreeActions(
        () => session,
        userActor(accountId),
        () => acting,
        closed,
      ),
    [session, accountId, acting, closed],
  );
}
