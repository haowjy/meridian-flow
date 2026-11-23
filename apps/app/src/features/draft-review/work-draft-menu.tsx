/**
 * The picked Work's drafts in a version chip's menu (`DraftSwitcher`), the same in the sidebar's
 * chip and a document's: each draft with how many files it changes, `+ New draft`, which makes
 * one and shows it, and `Delete draft` for the one on screen, which goes back to Live and leaves a
 * line with its Undo at the top of the sidebar (`DeletedDraftNotice`). Its Undo lists the draft
 * again and changes nothing on screen.
 */
import { plural, t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { WorkDraft } from "@meridian/contracts/drafts";
import { useSyncExternalStore } from "react";
import { ActionNotice } from "@/components/app/ActionNotice";
import type { ShellTreeVersion } from "@/features/project/tree-version";
import type { DraftVersion } from "./DraftSwitcher";
import { nextDraftName, workDraftName } from "./draft-names";

type Deleted = { projectId: string; draft: WorkDraft; restore: () => void };

let deleted: Deleted | null = null;
const listeners = new Set<() => void>();
function setDeleted(next: Deleted | null) {
  deleted = next;
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/**
 * The Work's drafts as menu entries, `current` on the one the shell shows on Draft; and the
 * menu's New and Delete. Null with no picked Work: a chat's own draft is the only one.
 */
export function workDraftMenu(
  projectId: string,
  shell: ShellTreeVersion | null,
  current: (draftId: string) => boolean,
): {
  drafts: DraftVersion[];
  onNewDraft: () => void;
  onDeleteDraft: (() => void) | undefined;
} | null {
  const state = shell?.workDrafts;
  if (!shell || !state?.drafts) return null;
  const list = state.drafts;
  const shown = list.find((draft) => draft.id === shell.draftId);
  return {
    drafts: list.map((draft) => {
      const files = draft.pendingDocumentCount + draft.pendingFolderCount;
      return {
        key: draft.id,
        name: workDraftName(draft),
        note: files > 0 ? plural(files, { one: "# file", other: "# files" }) : undefined,
        current: current(draft.id),
        scope: true,
        onSelect: () => shell.pick(draft.id),
      };
    }),
    onNewDraft: () => {
      const id = state.create(nextDraftName(list));
      if (id) shell.pick(id);
    },
    onDeleteDraft: shown
      ? () => {
          state.remove(shown);
          shell.leave();
          setDeleted({ projectId, draft: shown, restore: () => state.restore(shown) });
        }
      : undefined,
  };
}

/** "Darker ending deleted. Undo ×": the last `Delete draft` in this project, until dismissed. */
export function DeletedDraftNotice({ projectId }: { projectId: string }) {
  const notice = useSyncExternalStore(
    subscribe,
    () => deleted,
    () => null,
  );
  if (!notice || notice.projectId !== projectId) return null;
  return (
    <ActionNotice
      data-deleted-draft={notice.draft.id}
      sentence={(name) => t`${name} deleted.`}
      name={workDraftName(notice.draft)}
      action={{
        label: <Trans>Undo</Trans>,
        onClick: () => {
          notice.restore();
          setDeleted(null);
        },
      }}
      onDismiss={() => setDeleted(null)}
      className="px-2"
    />
  );
}
