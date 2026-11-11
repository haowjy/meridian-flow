/** Work-scoped authority over the account command owner; its notices live in the owner (`DraftNotices`). */

import { t } from "@lingui/core/macro";
import type { ThreadDraftListItem } from "@meridian/contracts/branches";
import { isWorkArchived, type Work } from "@meridian/contracts/works";
import { useQueryClient } from "@tanstack/react-query";
import type { Editor } from "@tiptap/core";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import {
  cachedOwnerDrafts,
  patchOwnerDrafts,
  relistedOwnerDraft,
  useOwnerDraftsFrozen,
} from "@/client/query/useOwnerDrafts";
import { documentBasename } from "@/client/query/work-branch-files";
import { editorHistory } from "@/core/editor/editor-history";
import {
  useDraftCommandOwner,
  useOptionalContextRemovalCoordinator,
  useOptionalDraftOnlyPresentations,
} from "@/features/project/context/account-feature-context";
import { isDeletedFromManuscript } from "./deleted-drafts";
import type { CapturedApply, CommandOutcome } from "./draft-command-owner";
import type { DiscardPart, NoticeSurface } from "./draft-notices";
import type { DraftReviewSelection } from "./draft-review-session";
import type { ChangeTarget } from "./review-model";

export type BranchCommandOutcome = CommandOutcome;
export type CommandStart = { sent: boolean; outcome: Promise<CommandOutcome> };
export type WorkBranchCommands = ReturnType<typeof useWorkBranchCommands>;

export function useWorkBranchCommands({
  projectId,
  work,
  ownerKey,
  threadId = null,
  surface,
  reviewEditor,
}: {
  projectId: string;
  work: Work | null;
  /** Whose drafts the commands act on (`work:<id>` or `lineage:<root>`); "" acts on none. */
  ownerKey: string;
  threadId?: string | null;
  /** Where this surface's notices show: the Changes list, a chat's strip, or a document's band. */
  surface: NoticeSurface["kind"];
  /**
   * A surface with an editor: the editor reviewing `draft` in this surface, whose own Undo takes
   * an Apply or Discard back (null: none is reviewing it, so the command is not sent). Without
   * it the surface has no editor, and the notice it shows takes a Discard back.
   */
  reviewEditor?: (draft: DraftReviewSelection) => Editor | null;
}) {
  const owner = useDraftCommandOwner();
  const queryClient = useQueryClient();
  const locked = !ownerKey || !work || isWorkArchived(work);
  // The server's word: a lineage with every chat in Trash. Its draft rooms drop the writer's
  // text, so a whole Discard goes to the server, which allows it, and nothing else is sent.
  const frozen = useOwnerDraftsFrozen(projectId, ownerKey);
  const notices = owner.notices;
  const removal = useOptionalContextRemovalCoordinator();
  const draftOnly = useOptionalDraftOnlyPresentations();
  return useMemo(() => {
    const ref = (draft: DraftReviewSelection) => ({ projectId, ownerKey, ...draft });
    const row = (draft: DraftReviewSelection) =>
      cachedOwnerDrafts(queryClient, projectId, ownerKey)?.find(
        (item) => item.itemKey === draft.itemKey,
      );
    // The Work's list re-reads with the touched documents' own reads: the route reads a
    // discarded move from the item's metadata, and the document header reads its draft hints.
    const refresh = (documentIds: readonly string[]) => {
      void queryClient.invalidateQueries({
        queryKey: projectQueryKeys.ownerDrafts(projectId, ownerKey),
      });
      for (const documentId of documentIds) {
        void queryClient.invalidateQueries({
          queryKey: projectQueryKeys.ownerDraftMetadataOf(projectId, ownerKey, documentId),
        });
        void queryClient.invalidateQueries({
          queryKey: projectQueryKeys.documentDraftHints(projectId, documentId),
        });
      }
    };
    /** The list without the item's move or delete, until the refetch confirms it. */
    const dropTreeLine = (item: ThreadDraftListItem) =>
      patchOwnerDrafts(queryClient, projectId, ownerKey, (rows) =>
        rows.flatMap((row) =>
          row.itemKey !== item.itemKey ? [row] : row.hasDraft ? [{ ...row, tree: null }] : [],
        ),
      );
    const blocked = (): CommandStart => ({
      sent: false,
      outcome: Promise.resolve({ kind: "blocked" }),
    });
    const noticeSurface = (draft: DraftReviewSelection): NoticeSurface =>
      surface === "band"
        ? { kind: "band", documentId: draft.documentId }
        : surface === "strip"
          ? { kind: "strip", threadId }
          : { kind: "changes" };
    const endNotice = () => notices.end(ownerKey);
    /**
     * The one Discard rule: whether this Discard runs here as a local text Discard, the only
     * kind with an Undo. That is a change the writer sees in a read frame, or a whole text
     * draft (not a created document or a picture, with no move or delete) whose room is read
     * now. Any other Discard asks first and goes to the server, which has no Undo (#763).
     */
    const discardsLocally = (draft: DraftReviewSelection, target: ChangeTarget) => {
      if (locked || frozen || target.kind === "tree") return false;
      if (target.kind === "groups") return !target.tree;
      const item = row(draft);
      return !item?.wholeItem && !item?.tree && owner.canDiscardLocally(draft.itemKey);
    };
    // Apply facts join the owner's notice until its next action. A band's go to the document's
    // identity row (`useManuscriptState`), never to the store, where no surface would show them.
    const applied = (
      draft: DraftReviewSelection,
      item: ThreadDraftListItem | undefined,
      outcome: Extract<CommandOutcome, { kind: "done" }>,
    ) => {
      if (surface === "band") return;
      const held = notices.appliedFacts(ownerKey);
      const title = item?.documentName ?? documentBasename(item?.contextLocation?.path) ?? null;
      const restored = [...(held?.restored ?? []), ...(outcome.restored && title ? [title] : [])];
      const renamed = [
        ...(held?.renamed ?? []),
        ...(outcome.applied ?? []).flatMap(({ renamed: path }) => {
          if (!path) return [];
          const name = documentBasename(path);
          return name ? [name] : [];
        }),
      ];
      const alsoApplied = [
        ...(held?.alsoApplied ?? []),
        ...(outcome.applied ?? []).flatMap((appliedItem) => {
          if (appliedItem.itemKey === item?.itemKey || !appliedItem.transition) return [];
          const from = documentBasename(appliedItem.transition.from);
          const to = documentBasename(appliedItem.transition.to);
          return from && to ? [`${from} → ${to}`] : [];
        }),
      ];
      if (restored.length || renamed.length || alsoApplied.length)
        notices.showApplied({
          projectId,
          ownerKey,
          surface: noticeSurface(draft),
          restored,
          renamed,
          alsoApplied,
        });
    };
    // An archived Work's refusal is silent (`shownRefusal`): its notice explains it once this tab
    // has read the archive, which another tab or device may have made.
    type CapturedStart = {
      release(treeAlreadyApplied?: boolean): CommandStart;
      captured: CapturedApply;
      present(outcome: CommandOutcome): void;
    };
    const captureApply = (
      draft: DraftReviewSelection,
      target: ChangeTarget,
      restore?: boolean,
      resetNotice = true,
    ): CapturedStart | null => {
      if (resetNotice) endNotice();
      if (locked) return null;
      const rows = cachedOwnerDrafts(queryClient, projectId, ownerKey) ?? [];
      const item = rows.find((candidate) => candidate.itemKey === draft.itemKey);
      const bringBack = restore ?? isDeletedFromManuscript(item);
      const tree = target.kind === "tree" || target.kind === "draft" || target.tree;
      const captured: CapturedApply | null = owner.captureApply(
        ref(draft),
        target,
        bringBack,
        (tree && item?.tree) || undefined,
        editorHistoryOf(reviewEditor?.(draft)),
      );
      if (!captured) return null;
      const present = (outcome: CommandOutcome) => {
        if (outcome.kind === "done" && tree && item?.tree) dropTreeLine(item);
        if (outcome.kind === "done") applied(draft, item, outcome);
        if (outcome.kind === "needs-restore" || !owner.state(draft.itemKey).pending)
          refresh([draft.documentId]);
      };
      return {
        captured,
        present,
        release(treeAlreadyApplied = false) {
          if (treeAlreadyApplied && target.kind === "tree") {
            void captured.release({ cancel: true }).outcome;
            if (item) dropTreeLine(item);
            refresh([draft.documentId]);
            return { sent: false, outcome: Promise.resolve({ kind: "done" }) };
          }
          const started = captured.release({ omitTree: treeAlreadyApplied });
          void started.outcome.then(present);
          return started;
        },
      };
    };
    const start = (
      mode: "apply" | "discard",
      draft: DraftReviewSelection,
      target: ChangeTarget,
      restore?: boolean,
      treeAlreadyApplied = false,
      resetNotice = true,
    ): CommandStart => {
      const started =
        mode === "apply"
          ? (captureApply(draft, target, restore, resetNotice)?.release(treeAlreadyApplied) ??
            blocked())
          : discardOne(draft, target, resetNotice);
      void started.outcome.then((outcome) => {
        if (outcome.kind === "change-refused" && outcome.code === "work_archived")
          void queryClient.invalidateQueries({ queryKey: projectQueryKeys.works(projectId) });
      });
      return started;
    };
    /**
     * `restore` is whether the writer chose to bring a deleted document back. A single
     * document's Apply means yes when its row showed it deleted; an Apply all passes what its
     * confirmation named.
     */
    const discardOne = (
      draft: DraftReviewSelection,
      target: ChangeTarget,
      resetNotice = true,
    ): CommandStart => {
      // A new Discard replaces the owner's notice, with its own or with none.
      if (resetNotice) endNotice();
      // A draft-only page (live deleted it elsewhere) has nothing left to show once its draft is
      // discarded: once the Discard is written, here or on the server, main goes back to the
      // document it showed before, and a notice follows it there. A refused Discard leaves main
      // on the page, which shows the refusal.
      const leaves =
        target.kind === "draft" && (draftOnly?.isDraftOnly(projectId, draft.documentId) ?? false);
      const { start, part } = dispatchDiscard(draft, target);
      const shown = part
        ? notices.showDiscard({
            projectId,
            ownerKey,
            surface: noticeSurface(draft),
            parts: [part],
          })
        : null;
      if (leaves && removal)
        void start.outcome.then((outcome) => {
          if (outcome.kind !== "done") return;
          removal.beginOwnRemoval(projectId, [draft.documentId], (landing) => {
            if (shown !== null) notices.landed(ownerKey, shown, landing);
          })([]);
        });
      return start;
    };
    /** Several Discards as one notice with one Undo, when every one of them carries an Undo. */
    const discardMany = (
      items: readonly { draft: DraftReviewSelection; target: ChangeTarget }[],
    ): Promise<CommandOutcome[]> => {
      endNotice();
      const undoable = items.every(({ draft, target }) => discardsLocally(draft, target));
      const started = items.map(({ draft, target }) => dispatchDiscard(draft, target));
      const parts = started.flatMap(({ part }) => (part ? [part] : []));
      const [first] = items;
      if (undoable && first)
        notices.showDiscard({ projectId, ownerKey, surface: noticeSurface(first.draft), parts });
      // The question said it can't be undone: no notice offers it.
      else for (const part of parts) part.handle.end();
      return Promise.all(started.map(({ start }) => start.outcome));
    };
    const dispatchDiscard = (
      draft: DraftReviewSelection,
      target: ChangeTarget,
    ): { start: CommandStart; part: DiscardPart | null } => {
      const none = (start: CommandStart) => ({ start, part: null });
      if (locked) return none(blocked());
      const item = row(draft);
      const history = reviewEditor ? reviewEditor(draft) : "notice";
      // A whole draft that can't be discarded here ends on the server, everything it holds.
      if (target.kind === "draft" && !discardsLocally(draft, target)) {
        if (!item) return none(blocked());
        const outcome = owner.discardOnServer(ref(draft), item, frozen).then((answer) => {
          if (answer.kind === "done")
            patchOwnerDrafts(queryClient, projectId, ownerKey, (rows) =>
              rows.filter((listed) => listed.itemKey !== item.itemKey),
            );
          refresh([draft.documentId]);
          return answer;
        });
        return none({ sent: true, outcome });
      }
      // A move or delete is discarded on the server, with the item's chosen text, as one command.
      if (target.kind === "tree" || (target.kind === "groups" && target.tree)) {
        if (!item?.tree) return none(blocked());
        // The line goes at once; the refetch after the answer restores it if the server refused.
        dropTreeLine(item);
        const outcome = owner.discardItem(ref(draft), item, target, history).then((answer) => {
          refresh([draft.documentId]);
          return answer;
        });
        return none({ sent: true, outcome });
      }
      const discarded = owner.discard(ref(draft), target, history);
      if (!discarded) return none(blocked());
      void discarded.outcome.then(() => refresh([draft.documentId]));
      const start = { sent: true, outcome: discarded.outcome };
      if (!discarded.handle) return none(start);
      return {
        start,
        part: {
          documentId: draft.documentId,
          name:
            item?.documentName ??
            documentBasename(item?.contextLocation?.path) ??
            t`Untitled document`,
          scope: target.kind === "draft" ? "draft" : "change",
          handle: discarded.handle,
          ...(item
            ? {
                review: {
                  documentId: draft.documentId,
                  documentName: item.documentName,
                  contextLocation: item.contextLocation,
                  draft: item,
                  draftOnly: item.isNew || item.deletedLive,
                },
              }
            : {}),
          // The row comes back with the prose. The list is read again only once the server lists
          // the draft: a read before then drops the row, and a page opened on it would close.
          undone: async (landed) => {
            if (!item) {
              refresh([draft.documentId]);
              return landed.then(() => false);
            }
            patchOwnerDrafts(queryClient, projectId, ownerKey, (rows) =>
              rows.some((listed) => listed.itemKey === item.itemKey) ? rows : [...rows, item],
            );
            await landed;
            const listed = await relistedOwnerDraft(queryClient, projectId, ownerKey, item.itemKey);
            refresh([draft.documentId]);
            return listed;
          },
        },
      };
    };
    const commandChange = (
      mode: "apply" | "discard",
      draft: DraftReviewSelection,
      target: ChangeTarget,
    ) => start(mode, draft, target).outcome;
    const startDraft = (mode: "apply" | "discard", draft: DraftReviewSelection) =>
      start(mode, draft, { kind: "draft" });
    return {
      projectId,
      ownerKey,
      threadId,
      owner,
      /** Whether this Discard asks first: it can't run here, so it carries no Undo. */
      discardAsks: (draft: DraftReviewSelection, target: ChangeTarget = { kind: "draft" }) =>
        !discardsLocally(draft, target),
      /** Whether a Discard of all these drafts asks first: one of them can't run here. */
      discardAllAsks: (drafts: readonly DraftReviewSelection[]) =>
        drafts.some((draft) => !discardsLocally(draft, { kind: "draft" })),
      dispositionLocked: locked,
      /** A frozen owner's draft takes no single-change command: only the whole draft's Discard. */
      changesLocked: locked || frozen,
      /** The owner's drafts are frozen (`ThreadDraftListResponse.frozen`): read-only, no Apply. */
      frozen,
      /**
       * Whether Apply is offered at all. A frozen owner (a lineage with every chat in Trash)
       * takes no Apply, so every surface hides it; an archived Work still shows it, disabled by
       * `dispositionLocked`.
       */
      canApply: !frozen,
      commandChange,
      startDraft,
      apply: (documentId: string, itemKey: string) =>
        startDraft("apply", { documentId, itemKey }).outcome,
      discard: (documentId: string, itemKey: string) =>
        startDraft("discard", { documentId, itemKey }).outcome,
      /** `restore`: the documents an Apply all's confirmation named; it brings back no other. */
      batch: (
        mode: "apply" | "discard",
        items: readonly { draft: DraftReviewSelection; target: ChangeTarget }[],
        restore: ReadonlySet<string> = new Set(),
      ) => {
        // Capture every item in the event turn, not in a promise continuation.
        if (mode === "apply") {
          endNotice();
          const captured = items.map(({ draft, target }) => ({
            draft,
            command: captureApply(draft, target, restore.has(draft.documentId), false),
          }));
          const outcomes = owner.releaseBatch(
            captured.map(({ draft, command }) => ({
              itemKey: draft.itemKey,
              command: command?.captured ?? null,
            })),
          );
          void outcomes.then((settled) => {
            settled.forEach((outcome, index) => {
              captured[index]?.command?.present(outcome);
            });
          });
          return outcomes;
        }
        return discardMany(items);
      },
      disposeDrafts: (
        mode: "apply" | "discard",
        drafts: readonly DraftReviewSelection[],
        restore: ReadonlySet<string> = new Set(),
      ) => {
        if (mode === "apply") {
          endNotice();
          const captured = drafts.map((draft) => ({
            draft,
            command: captureApply(
              draft,
              { kind: "draft" as const },
              restore.has(draft.documentId),
              false,
            ),
          }));
          const outcomes = owner.releaseBatch(
            captured.map(({ draft, command }) => ({
              itemKey: draft.itemKey,
              command: command?.captured ?? null,
            })),
          );
          void outcomes.then((settled) => {
            settled.forEach((outcome, index) => {
              captured[index]?.command?.present(outcome);
            });
          });
          return outcomes;
        }
        // Drafts that can all be discarded here are, one notice over their rooms; any other
        // Discard all asked first, and the server ends every draft of the branch.
        if (drafts.every((draft) => discardsLocally(draft, { kind: "draft" })))
          return discardMany(
            drafts.map((draft) => ({ draft, target: { kind: "draft" as const } })),
          );
        endNotice();
        const branchId = drafts.map(row).find(Boolean)?.branchId;
        if (locked || !branchId)
          return Promise.resolve(drafts.map(() => ({ kind: "blocked" as const })));
        return owner.discardAll(drafts.map(ref), branchId).then((answer) => {
          refresh(drafts.map((draft) => draft.documentId));
          return drafts.map(() => answer);
        });
      },
    };
  }, [
    owner,
    notices,
    removal,
    draftOnly,
    locked,
    frozen,
    projectId,
    ownerKey,
    threadId,
    surface,
    reviewEditor,
    queryClient,
  ]);
}

const editorHistoryOf = (editor: Editor | null | undefined) =>
  editor ? editorHistory(editor) : null;

const WorkBranchCommandsContext = createContext<WorkBranchCommands | null>(null);
export function WorkBranchCommandsBoundary({
  value,
  children,
}: {
  value: WorkBranchCommands;
  children: ReactNode;
}) {
  return (
    <WorkBranchCommandsContext.Provider value={value}>
      {children}
    </WorkBranchCommandsContext.Provider>
  );
}
export function useBoundWorkBranchCommands(): WorkBranchCommands {
  const commands = useContext(WorkBranchCommandsContext);
  if (!commands) throw new Error("Work commands require a WorkBranchCommandsBoundary");
  return commands;
}
