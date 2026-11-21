/**
 * Ctrl+Z in the sidebar: takes back the writer's latest tree change in the shown source, made in
 * the view the toggle shows, or their latest Apply as one step (`tree-undo.ts`); on the Changes
 * tab, the latest of any source. A step that no longer fits is skipped, and its rows say so
 * (`TreeNotice`). Focus follows to the row the press brings back, as a row's Undo does. A press
 * inside a text field is the field's own Undo.
 */
import { type KeyboardEvent, useMemo, useRef } from "react";
import { useTreeList } from "@/client/query/useProjectTree";
import { followFocusFrom } from "@/components/app/RowWord";
import { undoLatest } from "@/core/project-tree/tree-undo";
import type { TreeVersion } from "@/core/project-tree/tree-version";
import { useAccountId } from "../../context/account-feature-context";
import { useClosedOwners } from "../../context/closed-owners";
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
      /** Claims the event when it is the sidebar's Undo. */
      handles(event: KeyboardEvent): boolean {
        if (event.defaultPrevented || !isUndoKey(event) || isTextField(event.target)) return false;
        event.preventDefault();
        return true;
      },
      /**
       * `accountList`: the source is the account's (`user://`). `source` null: the Changes tab,
       * whose press takes the latest step of any source. A press while one waits on the server
       * is dropped: the stack is read one press at a time.
       */
      press(accountList: boolean, source: string | null) {
        const session = (accountList ? account : project).session;
        if (!session || pressing.current) return;
        pressing.current = true;
        const from = document.activeElement;
        const follow = from ? followFocusFrom(from) : null;
        void undoLatest(session, source, version.view, `user:${accountId}`, closed)
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
