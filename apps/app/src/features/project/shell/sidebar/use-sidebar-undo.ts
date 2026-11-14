/**
 * Ctrl+Z in the sidebar: takes back the writer's latest tree change in the shown source, made in
 * the view the toggle shows (`tree-undo.ts`). A step that no longer fits is skipped, and the toast
 * says which. A press inside a text field is the field's own Undo.
 */
import { plural, t } from "@lingui/core/macro";
import { type KeyboardEvent, useCallback, useMemo, useRef, useState } from "react";
import { useTreeList } from "@/client/query/useProjectTree";
import type { StatusToastNotice } from "@/components/app/StatusToast";
import { undoLatest } from "@/core/project-tree/tree-undo";
import type { TreeVersion } from "@/core/project-tree/tree-version";
import { useAccountId } from "../../context/account-feature-context";

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
  const [notice, setNotice] = useState<StatusToastNotice | null>(null);
  const ids = useRef(0);
  const dismiss = useCallback(() => setNotice(null), []);
  return useMemo(
    () => ({
      notice,
      dismiss,
      /** Claims the event when it is the sidebar's Undo. */
      handles(event: KeyboardEvent): boolean {
        if (event.defaultPrevented || !isUndoKey(event) || isTextField(event.target)) return false;
        event.preventDefault();
        return true;
      },
      /** `accountList`: the source is the account's (`user://`). */
      press(accountList: boolean, source: string) {
        const session = (accountList ? account : project).session;
        if (!session) return;
        const outcome = undoLatest(
          session,
          source,
          version.view,
          `user:${accountId}`,
          version.pendingText,
        );
        const [only] = outcome.skipped;
        if (outcome.skipped.length === 0) setNotice(null);
        else {
          ids.current += 1;
          setNotice({
            id: ids.current,
            text:
              outcome.skipped.length === 1 && only
                ? t`Skipped your change to ${only}: it was changed again since.`
                : plural(outcome.skipped.length, {
                    one: "Skipped # change that was changed again since.",
                    other: "Skipped # changes that were changed again since.",
                  }),
          });
        }
      },
    }),
    [notice, dismiss, account, project, version, accountId],
  );
}
