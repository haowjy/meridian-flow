/**
 * The picked Work's drafts in a version chip's menu (`DraftSwitcher`), the same in the sidebar's
 * chip and a document's: each draft with how many files it changes, `+ New draft`, which makes
 * one and shows it, and `Delete draft` for the one on screen, which goes back to Live. Its notice,
 * "Darker ending deleted. Undo", is the project's delete notice (`deleteNoticeKey`), on main's
 * document or Recently opened; its Undo lists the draft again and changes nothing on screen.
 */
import { plural } from "@lingui/core/macro";
import type { WorkDraft } from "@meridian/contracts/drafts";
import type { ReactNode } from "react";
import {
  useDraftCommandOwner,
  useOptionalPresentedDocuments,
} from "@/features/project/context/account-feature-context";
import type { ShellTreeVersion } from "@/features/project/tree-version";
import type { DraftVersion } from "./DraftSwitcher";
import { nextDraftName, workDraftName } from "./draft-names";
import { deleteNoticeKey } from "./draft-notices";

/** A Work's drafts as `WorkDraftRows` lists them: each with how many files it changes. */
export function workDraftVersions(
  list: readonly WorkDraft[],
  current: (draftId: string) => boolean,
  pick: (draftId: string) => void,
): DraftVersion[] {
  return list.map((draft) => {
    const files = draft.pendingDocumentCount + draft.pendingFolderCount;
    return {
      key: draft.id,
      name: workDraftName(draft),
      note: files > 0 ? plural(files, { one: "# file", other: "# files" }) : undefined,
      current: current(draft.id),
      scope: true,
      onSelect: () => pick(draft.id),
    };
  });
}

/**
 * The Work's drafts as menu entries, `current` on the one on screen; the name the chip gives it
 * (`owner`), among several; and the menu's New and Delete. Null with no picked Work: a chat's own
 * draft is the only one.
 */
export function useWorkDraftMenu(
  projectId: string,
  shell: ShellTreeVersion | null,
  current: (draftId: string) => boolean,
): {
  drafts: DraftVersion[];
  owner: ReactNode | undefined;
  onNewDraft: () => void;
  onDeleteDraft: (() => void) | undefined;
} | null {
  const { notices } = useDraftCommandOwner();
  const presented = useOptionalPresentedDocuments();
  const state = shell?.workDrafts;
  if (!shell || !state?.drafts) return null;
  const list = state.drafts;
  const shown = list.find((draft) => draft.id === shell.draftId);
  const drafts = workDraftVersions(list, current, shell.pick);
  return {
    drafts,
    owner: drafts.length > 1 ? drafts.find((draft) => draft.current)?.name : undefined,
    onNewDraft: () => {
      const id = state.create(nextDraftName(list));
      if (id) shell.pick(id);
    },
    onDeleteDraft: shown
      ? () => {
          state.remove(shown);
          shell.leave();
          const main = presented?.mainDocumentId(projectId) ?? null;
          notices.showDiscard({
            projectId,
            draftId: deleteNoticeKey(projectId),
            surface: main ? { kind: "band", documentId: main } : { kind: "landing" },
            parts: [
              {
                documentId: main ?? shown.id,
                name: workDraftName(shown),
                scope: "deleted",
                handle: {
                  undo: () => {
                    state.restore(shown);
                    return { answer: "ok" };
                  },
                  end: () => {},
                },
              },
            ],
          });
        }
      : undefined,
  };
}
