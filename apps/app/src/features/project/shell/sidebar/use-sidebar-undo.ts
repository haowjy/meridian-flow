import { userActor } from "@meridian/project-tree";
import { type KeyboardEvent, useMemo, useRef } from "react";
import { useAccountId } from "@/client/account/account-context";
import { useClosedOwners } from "@/client/query/closed-owners";
import { useTreeList } from "@/client/query/useProjectTree";
import { followFocusFrom } from "@/components/app/RowWord";
import { undoLatest } from "@/core/project-tree/tree-undo";
import type { TreeVersion } from "@/core/project-tree/tree-version";
import { entryRowOf } from "../../context/use-tree-notice-words";

const isUndoKey = (event: KeyboardEvent) =>
  (event.key === "z" || event.key === "Z") &&
  (event.ctrlKey || event.metaKey) &&
  !event.shiftKey &&
  !event.altKey;

function isTextField(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.closest("input, textarea, [contenteditable]") !== null)
  );
}

export function useSidebarUndo(projectId: string, version: TreeVersion) {
  const accountId = useAccountId();
  const project = useTreeList({ kind: "project", projectId });
  const account = useTreeList({ kind: "account", userId: accountId });
  const closed = useClosedOwners(projectId);
  const pressing = useRef(false);
  return useMemo(
    () => ({
      handles(event: KeyboardEvent): boolean {
        if (event.defaultPrevented || !isUndoKey(event) || isTextField(event.target)) return false;
        event.preventDefault();
        return true;
      },
      press(accountList: boolean, source: string | null) {
        const session = (accountList ? account : project).session;
        if (!session || pressing.current) return;
        pressing.current = true;
        const from = document.activeElement;
        const follow = from ? followFocusFrom(from) : null;
        void undoLatest(session, source, version.view, userActor(accountId), closed)
          .then((outcome) => {
            const [node] = outcome.kind === "undone" ? outcome.nodes : [];
            if (node && follow) follow(() => entryRowOf(node));
          })
          .finally(() => {
            pressing.current = false;
          });
      },
    }),
    [account, project, version, accountId, closed],
  );
}
