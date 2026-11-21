/** The writer's tree actions for a project's screens: the project's list and the account's (`user://`). */
import type { TreeProjection } from "@meridian/project-tree";
import { useMemo } from "react";
import { useTreeList } from "@/client/query/useProjectTree";
import { useTreeActions } from "@/client/query/useTreeActions";
import type { TreeActions } from "@/core/project-tree/tree-actions";
import { type TreeVersion, useTreeVersion } from "@/core/project-tree/tree-version";
import { useAccountId } from "../account-feature-context";

export type EntryActions = {
  project: TreeActions;
  account: TreeActions;
  /** The list that holds `node`: the account's when its replay does, else the project's. */
  holding(node: string): { list: TreeActions; replay: TreeProjection | null };
};

/** The actions in the shell's Live/Draft version, or in `version` when the caller names one. */
export function useEntryActions(projectId: string, version?: TreeVersion): EntryActions {
  const accountId = useAccountId();
  const shown = useTreeVersion();
  const acting = version ?? shown;
  const project = useTreeActions({ kind: "project", projectId }, acting);
  const account = useTreeActions({ kind: "account" }, acting);
  const projectList = useTreeList({ kind: "project", projectId });
  const accountList = useTreeList({ kind: "account", userId: accountId });
  const { view } = acting;
  return useMemo(
    () => ({
      project,
      account,
      holding: (node) => {
        const own = accountList.session?.replay(view);
        if (own?.nodes.has(node)) return { list: account, replay: own };
        return { list: project, replay: projectList.session?.replay(view) ?? null };
      },
    }),
    [project, account, projectList.session, accountList.session, view],
  );
}
