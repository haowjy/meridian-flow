/**
 * Ctrl+Z in the sidebar: takes back the writer's latest tree change in the shown source, made in
 * the view the toggle shows, or their latest Apply as one step (`tree-undo.ts`); on the Changes
 * tab, the latest of any source. A step that no longer fits is skipped, and the toast
 * says which. A press inside a text field is the field's own Undo.
 */
import { plural, t } from "@lingui/core/macro";
import { type KeyboardEvent, useCallback, useMemo, useRef, useState } from "react";
import { useTreeList } from "@/client/query/useProjectTree";
import type { StatusToastNotice } from "@/components/app/StatusToast";
import { type UndoOutcome, undoLatest } from "@/core/project-tree/tree-undo";
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
  const pressing = useRef(false);
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
      /**
       * `accountList`: the source is the account's (`user://`). `source` null: the Changes tab,
       * whose press takes the latest step of any source. A press while one waits on the server
       * is dropped: the stack is read one press at a time.
       */
      press(accountList: boolean, source: string | null) {
        const session = (accountList ? account : project).session;
        if (!session || pressing.current) return;
        pressing.current = true;
        void undoLatest(session, source, version.view, `user:${accountId}`, version.pendingText)
          .then((outcome) => {
            const text = noticeOf(outcome);
            if (text === null) setNotice(null);
            else {
              ids.current += 1;
              setNotice({ id: ids.current, text });
            }
          })
          .finally(() => {
            pressing.current = false;
          });
      },
    }),
    [notice, dismiss, account, project, version, accountId],
  );
}

/**
 * What a press says: which steps it skipped, the text an Apply's Undo left applied, or that it
 * didn't reach the server.
 */
function noticeOf(outcome: UndoOutcome): string | null {
  const skipped = outcome.skipped;
  const [only] = skipped;
  const said =
    skipped.length === 0
      ? null
      : skipped.length === 1 && only
        ? only.kind === "apply"
          ? t`Skipped applying ${only.name}: the tree changed since.`
          : t`Skipped your change to ${only.name}: it was changed again since.`
        : plural(skipped.length, {
            one: "Skipped # change that was changed again since.",
            other: "Skipped # changes that were changed again since.",
          });
  if (outcome.kind === "undone" && outcome.partial) {
    const { name, textLeft } = outcome.partial;
    const stayed = plural(textLeft, {
      one: "# text change stayed: it was edited since.",
      other: "# text changes stayed: they were edited since.",
    });
    const partial = `${t`Undid applying ${name}.`} ${stayed}`;
    return said ? `${said} ${partial}` : partial;
  }
  if (outcome.kind !== "failed") return said;
  const name = outcome.name;
  const failed = t`Couldn't undo applying ${name}. Try again.`;
  return said ? `${said} ${failed}` : failed;
}
