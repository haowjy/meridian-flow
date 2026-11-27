import { plural } from "@lingui/core/macro";
import type { WorkDraft } from "@meridian/contracts/drafts";
import type { ReactNode } from "react";
import {
  useDraftCommandOwner,
  useOptionalContextRemovalCoordinator,
  useOptionalPresentedDocuments,
} from "@/client/account/account-composition";
import { deleteNoticeKey } from "@/client/draft-commands/draft-notices";
import { useDraftOnly } from "@/client/query/useOwnerDrafts";
import type { ShellTreeVersion } from "@/features/project/tree-version";
import type { DraftVersion } from "./DraftSwitcher";
import { nextDraftName, workDraftName } from "./draft-names";

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
  const removal = useOptionalContextRemovalCoordinator();
  const draftOnly = useDraftOnly(projectId, shell?.draftId ?? null);
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
          const main = presented?.mainDocumentId(projectId) ?? null;
          let notice: number | null = null;
          if (main && draftOnly(main))
            removal?.leaveDraftOnly(projectId, main, (landing) => {
              if (notice !== null) notices.landed(deleteNoticeKey(projectId), notice, landing);
            });
          shell.leave();
          notice = notices.showDiscard({
            projectId,
            draftId: deleteNoticeKey(projectId),
            surface: main ? { kind: "page", documentId: main, draftId: null } : { kind: "landing" },
            scope: "deleted",
            name: workDraftName(shown),
            documentIds: [main ?? shown.id],
            undo: () => {
              state.restore(shown);
              return true;
            },
          });
        }
      : undefined,
  };
}
