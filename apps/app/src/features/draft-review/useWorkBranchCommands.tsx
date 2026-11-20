/** Work-scoped authority over the account command owner; its notices live in the owner (`DraftNotices`). */

import { t } from "@lingui/core/macro";
import { type BranchId, draftItemKey, parseDraftItemKey } from "@meridian/contracts";
import type { ThreadDraftListItem, ThreadDraftListResponse } from "@meridian/contracts/branches";
import { draftRoomName } from "@meridian/contracts/protocol";
import { type Work, workLifecycleState } from "@meridian/contracts/works";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import type { Editor } from "@tiptap/core";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import { applyItems, branchOf, unapplyCommand, undoDiscard } from "@/client/api/branches-api";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import {
  cachedOwnerDrafts,
  patchOwnerDrafts,
  relistedOwnerDraft,
  useOwnerDraftList,
  useOwnerDraftsFrozen,
} from "@/client/query/useOwnerDrafts";
import { refreshTurnCards } from "@/client/query/useTurnLiveLineage";
import { documentBasename, type ReviewFileTarget } from "@/client/query/work-branch-files";
import { editorHistory } from "@/core/editor/editor-history";
import {
  type ApplyStep,
  dropUndoStep,
  endWhenTakenBack,
  pushUndoStep,
  shownSourceOf,
} from "@/core/project-tree/tree-undo";
import { draftTreeVersion } from "@/core/project-tree/tree-version";
import {
  useDraftCommandOwner,
  useLiveDocumentSessionRegistry,
  useOptionalContextRemovalCoordinator,
  useOptionalDraftOnlyPresentations,
  useOptionalTreeLists,
} from "@/features/project/context/account-feature-context";
import { useClosedOwners } from "@/features/project/context/closed-owners";
import { ApplyEntries, type Seat, serverPort } from "./apply-history";
import type { RestoreAnswer } from "./discard-restores";
import { type CommandOutcome, type DraftCommandOwner, folderKey } from "./draft-command-owner";
import {
  type AppliedFact,
  type ApplyHalves,
  type DiscardUndo,
  halvesOf,
  type NoticeSurface,
} from "./draft-notices";
import type { DraftReviewSelection } from "./draft-review-session";
import { type FrameCut, frameCut } from "./review-frame";
import type { ApplyTarget, ChangeTarget } from "./review-model";

export type BranchCommandOutcome = CommandOutcome;
/** What an Apply that landed landed, which its Undo step is made of. */
type StepData = {
  commandId: string;
  branchId: string;
  nodes: readonly string[];
  /** The draft each document was applied from: Ctrl+Z in its editor takes the Apply back too. */
  drafts: Readonly<Record<string, string>>;
  halves?: ApplyHalves;
};
/** What an Apply's sidebar step holds besides its Undo. */
type StepInit = Omit<ApplyStep, "kind" | "undo">;
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
  const registry = useLiveDocumentSessionRegistry();
  const queryClient = useQueryClient();
  const locked = !ownerKey;
  // The server's word: a lineage with every chat in Trash. Its draft rooms drop the writer's
  // text, so a whole Discard goes to the server, which allows it, and nothing else is sent.
  const frozen = useOwnerDraftsFrozen(projectId, ownerKey);
  const notices = owner.notices;
  const removal = useOptionalContextRemovalCoordinator();
  const treeLists = useOptionalTreeLists();
  const draftOnly = useOptionalDraftOnlyPresentations();
  // The Work's own creates the server has not listed (`useCreatedDrafts`) are rows too: a
  // command on one finds no row in the query cache, and a missing row is blocked silently.
  const { created } = useOwnerDraftList(projectId, ownerKey, Boolean(ownerKey));
  const closed = useClosedOwners(projectId);
  return useMemo(() => {
    const ref = (draft: DraftReviewSelection) => ({ projectId, ownerKey, ...draft });
    /** The cut the review rows were read at: records after it are ones the writer hadn't seen. */
    const sawNow = () =>
      queryClient.getQueryData<ThreadDraftListResponse>(
        projectQueryKeys.ownerDrafts(projectId, ownerKey),
      )?.saw;
    const listed = () => {
      const cached = cachedOwnerDrafts(queryClient, projectId, ownerKey);
      return cached || created.length > 0 ? [...(cached ?? []), ...created] : null;
    };
    const row = (draft: DraftReviewSelection) =>
      listed()?.find((item) => item.itemKey === draft.itemKey);
    // The Work's list re-reads with the touched documents' own reads: the route reads a
    // discarded move from the item's metadata, and the document header reads its draft hints.
    const refresh = (documentIds: readonly string[]) => {
      refreshTurnCards(queryClient);
      void queryClient.invalidateQueries({ queryKey: projectQueryKeys.trashDiscards(projectId) });
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
    /**
     * The list without what a command took from the item, until the refetch confirms it: its
     * move or delete (`tree`), its text changes (`text`), and the row once nothing is left.
     */
    const dropTaken = (item: ThreadDraftListItem, took: { tree: boolean; text: boolean }) =>
      patchOwnerDrafts(queryClient, projectId, ownerKey, (rows) =>
        rows.flatMap((row) => {
          if (row.itemKey !== item.itemKey) return [row];
          const left = {
            ...row,
            ...(took.tree ? { tree: null } : {}),
            ...(took.text ? { textChanges: 0 } : {}),
          };
          return left.tree || (left.hasDraft && !took.text) ? [left] : [];
        }),
      );
    /** A Discard's item left review, taken here or before: all but one an Apply took first. */
    const leftReview = (answer: CommandOutcome) =>
      answer.kind === "done" || answer.kind === "settled";
    /** Whether an Apply asks for the item's tree records: the target names them and the row has one pending. */
    const treeAsked = (target: ApplyTarget, item: ThreadDraftListItem | undefined) =>
      Boolean((target.kind === "tree" || target.kind === "draft" || target.tree) && item?.tree);
    /** The list item's draft, which an Apply of the whole draft names when no room is open. */
    const withDraft = (target: ApplyTarget, item: ThreadDraftListItem | undefined): ApplyTarget =>
      target.kind === "draft" && item?.draftId ? { kind: "draft", draftId: item.draftId } : target;
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
     * A server Discard's share of the notice, as its answer says: only what it took stays, and
     * what an Apply took first says so (`DraftNotices.answered`). A share it never answered for
     * (refused, blocked) leaves.
     */
    const answeredShare = (handle: DiscardUndo, answer: CommandOutcome) => {
      const took = answer.kind === "done" || answer.kind === "settled" ? answer.took : undefined;
      if (took) notices.answered(handle, took);
      else if (answer.kind !== "done") notices.partEnded(handle);
    };
    /** A closed owner's `returned` answer says nothing; the Works list is read again, since the writer's view of the Work was stale. */
    const refreshWorksIfReturned = (outcome: CommandOutcome) => {
      if (outcome.kind === "returned")
        void queryClient.invalidateQueries({ queryKey: projectQueryKeys.works(projectId) });
    };
    const titleOf = (item: ThreadDraftListItem | undefined) =>
      item?.documentName ?? documentBasename(item?.contextLocation?.path) ?? null;
    // Apply facts join the owner's notice until its next action. A band's go to the document's
    // identity row (`useManuscriptState`), never to the store, where no surface would show them.
    const applied = (
      draft: DraftReviewSelection,
      done: readonly {
        item: ThreadDraftListItem | undefined;
        outcome: Extract<CommandOutcome, { kind: "done" }>;
      }[],
      step: ApplyEntries | null,
    ) => {
      if (surface === "band" || done.length === 0) return;
      const held = notices.appliedFacts(ownerKey)?.facts ?? [];
      const picked = new Set(done.flatMap(({ item }) => (item ? [item.itemKey] : [])));
      // Every member of one command answers with the command's whole list.
      const said = [
        ...new Map(
          done.flatMap(({ outcome }) => outcome.applied ?? []).map((fact) => [fact.itemKey, fact]),
        ).values(),
      ];
      // A document the Apply put somewhere new says where: a new one would look lost otherwise.
      const fresh: AppliedFact[] = said.flatMap((fact): AppliedFact[] => {
        const documentId = parseDraftItemKey(fact.itemKey)?.documentId;
        const { transition } = fact;
        if (
          !documentId ||
          !picked.has(fact.itemKey) ||
          !transition?.to ||
          folderOf(transition.from) === folderOf(transition.to)
        )
          return [];
        return [
          {
            documentId,
            kind: "landed",
            uri: transition.to,
            name: documentBasename(transition.to) ?? "",
          },
        ];
      });
      // Every document the writer applied has its Undo on its row, a plain Apply as much as one
      // that moved it.
      const told = new Set(fresh.map((fact) => fact.documentId));
      for (const { item } of done) {
        const name = titleOf(item);
        if (item && name && !told.has(item.documentId)) {
          told.add(item.documentId);
          fresh.push({ documentId: item.documentId, kind: "applied", name });
        }
      }
      const facts = [...held, ...fresh.map((fact) => (step ? { ...fact, step } : fact))];
      if (facts.length)
        notices.showApplied({ projectId, ownerKey, surface: noticeSurface(draft), facts });
    };
    /**
     * What a landed Apply's step is made of, read from the Work's tree: the nodes it took, their
     * sources, what its tree half did to each. `account`: a node the project's list doesn't show is
     * in the account's, whose list its tree half is read in too. Null without the tree lists.
     */
    const stepOf = (data: StepData) => {
      if (!treeLists) return null;
      const halves = data.halves ?? { text: true, tree: true, restores: [] };
      const handle = treeLists.acquire({ kind: "project", projectId });
      const session = handle.session;
      // The Work's tree shows every node the Apply took, before it and after.
      const { view, pendingText } = draftTreeVersion(
        data.branchId,
        listed(),
        work ? workLifecycleState(work) : "active",
      );
      const shown = session.replay(view, pendingText);
      handle.release();
      const init: StepInit = {
        sources: [...new Set(data.nodes.flatMap((node) => shownSourceOf(shown, node) ?? []))],
        nodes: data.nodes,
        text: halves.text,
        tree: halves.tree ? { command: data.commandId, restores: halves.restores } : null,
      };
      return {
        init,
        session,
        documentIds: data.nodes.filter((node) => shown.nodes.get(node)?.kind !== "folder"),
        account: data.nodes.some((node) => !shown.nodes.has(node)),
      };
    };
    /**
     * An Apply goes on the sidebar's Undo stack as one step (`ApplyStep`) and in the history of
     * every editor open on its documents (`ApplyEntries`): the Undo of both is the server's
     * Un-Apply of the whole command, and the Redo of an editor's is the server's own reading of
     * what that Un-Apply took back. A band's Apply has only its editor's entry.
     */
    const rememberApply = (data: StepData): ApplyEntries | null => {
      const made = stepOf(data);
      if (!made) return null;
      let { documentIds, account } = made;
      const { branchId, drafts } = data;
      const historiesOf = (documentId: string) => {
        const draftId = drafts[documentId];
        return [
          registry.history(documentId),
          draftId ? registry.history(draftRoomName(draftId)) : null,
        ];
      };
      const step: ApplyStep = {
        kind: "apply",
        ...made.init,
        undo: async () => (await entries.undo(null)).kind !== "failed",
      };
      // On the sidebar's stack while it can be taken back, with a watch that ends its tree half
      // once nothing of it stands (a card's Undo of its rename).
      let stopWatch: (() => void) | null = null;
      let accountList: ReturnType<NonNullable<typeof treeLists>["acquire"]> | null = null;
      const seat: Seat = {
        push: () => {
          accountList = account && treeLists ? treeLists.acquire(treeLists.account) : null;
          pushUndoStep(made.session, step);
          stopWatch = endWhenTakenBack(
            accountList ? [made.session, accountList.session] : [made.session],
            step,
            () => {
              step.tree = null;
              if (!step.text) entries.end();
            },
          );
        },
        drop: () => {
          stopWatch?.();
          stopWatch = null;
          accountList?.release();
          accountList = null;
          dropUndoStep(made.session, step);
          if (notices.appliedFacts(ownerKey)?.facts.some((fact) => fact.step === entries))
            endNotice();
        },
      };
      const entries: ApplyEntries = new ApplyEntries(
        data.commandId,
        serverPort({
          unapply: (body) => unapplyCommand(projectId, branchId, body),
          redo: (body) => applyItems(projectId, branchId, body),
          unapplied: async () => {
            refresh(documentIds);
            // The Apply's notice ends once the list has the Work's row back: the list the Apply
            // left has none, so ending it earlier leaves the writer no row until the read lands.
            await queryClient.refetchQueries(
              { queryKey: projectQueryKeys.ownerDrafts(projectId, ownerKey) },
              { cancelRefetch: false },
            );
          },
          redone: async (answer) => {
            const landed = stepOf({
              commandId: answer.commandId,
              branchId,
              nodes: answer.items.flatMap((item) =>
                item.tree?.landed || item.text?.landed ? [item.node] : [],
              ),
              drafts,
              halves: halvesOf(answer),
            });
            if (landed) {
              Object.assign(step, landed.init);
              ({ documentIds, account } = landed);
            }
            refresh(documentIds);
          },
        }),
        () => documentIds.flatMap(historiesOf),
        seat,
        () => owner.applied.delete(entries),
      );
      owner.applied.add(entries);
      return entries;
    };
    const applyOne = (draft: DraftReviewSelection, target: ApplyTarget): CommandStart => {
      endNotice();
      const item = row(draft);
      const tree = treeAsked(target, item);
      const started = locked
        ? null
        : owner.apply(
            ref(draft),
            withDraft(target, item),
            tree,
            sawNow(),
            surface === "band"
              ? {
                  histories: () => [
                    editorHistoryOf(reviewEditor?.(draft)),
                    registry.history(draft.documentId),
                  ],
                }
              : null,
          );
      if (!started) return blocked();
      void started.outcome.then((outcome) => {
        if (outcome.kind === "done" && item)
          dropTaken(item, {
            tree: Boolean(outcome.treeWhole && tree),
            text: target.kind === "draft" && (outcome.halves?.text ?? true),
          });
        // A band's Apply is its editors' Undo alone.
        const step =
          !started.band && outcome.kind === "done" && outcome.commandId && item
            ? rememberApply({
                commandId: outcome.commandId,
                branchId: item.branchId,
                nodes: [draft.documentId],
                drafts: item.draftId ? { [draft.documentId]: item.draftId } : {},
                halves: outcome.halves,
              })
            : null;
        if (outcome.kind === "done") applied(draft, [{ item, outcome }], step);
        if (!owner.state(draft.itemKey).pending) refresh([draft.documentId]);
      });
      return started;
    };
    /**
     * Several drafts and folders as one Apply command, one step of Undo: Apply all, a folder's ✓.
     * `folders`: the folder changes it takes, with what is listed under them. `outcomes` resolves
     * to each item's outcome.
     */
    const applyMany = (
      items: readonly { draft: DraftReviewSelection; target: ChangeTarget }[],
      folders: readonly string[] = [],
    ): Promise<CommandOutcome[]> => {
      endNotice();
      const listedDrafts = queryClient.getQueryData<ThreadDraftListResponse>(
        projectQueryKeys.ownerDrafts(projectId, ownerKey),
      );
      const branchId = listedDrafts?.branchId;
      if (locked || !branchId)
        return Promise.resolve(items.map(() => ({ kind: "blocked" as const })));
      const members = items.map(({ draft, target }) => {
        const item = row(draft);
        return { draft, item, target: withDraft(target, item), tree: treeAsked(target, item) };
      });
      const started = owner.applyGroup({
        projectId,
        ownerKey,
        branchId,
        members: members.map(({ draft, target, tree }) => ({ ref: ref(draft), target, tree })),
        folders,
        saw: sawNow(),
      });
      started.outcomes.forEach((outcome, index) => {
        const member = members[index];
        if (!member) return;
        void outcome.then((settled) => {
          if (settled.kind === "done" && member.item)
            dropTaken(member.item, {
              tree: Boolean(settled.treeWhole && member.tree),
              text: member.target.kind === "draft" && (settled.halves?.text ?? true),
            });
        });
      });
      // One refresh for the command: a refresh per member refetched the list once per member.
      void Promise.all(started.outcomes.slice(0, members.length)).then(() => {
        const documentIds = members.flatMap(({ draft }) =>
          !owner.state(draft.itemKey).pending ? [draft.documentId] : [],
        );
        if (documentIds.length) refresh(documentIds);
      });
      const [first] = members;
      const outcomes = Promise.all(started.outcomes.slice(0, members.length));
      void Promise.all([outcomes, Promise.all(started.outcomes), started.answer]).then(
        ([settled, _all, answer]) => {
          // The step is what the answer says landed, not what was pressed: an item settled
          // before it (an earlier Discard's, another Apply's) is no part of its Undo.
          const landed = answer?.status === "applied" ? answer : null;
          const taken =
            landed?.items.flatMap((item) =>
              item.tree?.landed || item.text?.landed ? [item.node] : [],
            ) ?? [];
          // Only an Apply that landed something is a step: Ctrl+Z would take an empty one.
          const step =
            taken.length > 0 && landed
              ? rememberApply({
                  commandId: landed.commandId,
                  branchId,
                  nodes: taken,
                  drafts: Object.fromEntries(
                    members.flatMap(({ draft, item }) =>
                      item?.draftId && taken.includes(draft.documentId)
                        ? [[draft.documentId, item.draftId]]
                        : [],
                    ),
                  ),
                  halves: halvesOf(landed),
                })
              : null;
          if (first)
            applied(
              first.draft,
              settled.flatMap((outcome, index) =>
                outcome.kind === "done" ? [{ item: members[index]?.item, outcome }] : [],
              ),
              step,
            );
          if (folders.length > 0) refresh([]);
        },
      );
      return outcomes;
    };
    /**
     * The Undo of a Discard: its Restore command, which brings both halves back, sent through the
     * one restore progress Trash and the editor read.
     */
    const serverUndo = (
      branchId: string,
      discardCommandId: string,
      documentIds: readonly string[],
    ): DiscardUndo => ({
      undo: async () => ({
        landed: Promise.resolve(),
        ...(await owner.restores.restore(discardCommandId, () =>
          restoreDiscard(queryClient, { projectId, branchId, discardCommandId, documentIds }),
        )),
      }),
      end: () => {},
    });
    /**
     * The one Discard, every one: Discard all, a selection, a document's changes or all of them, a
     * move or delete. One server command with one id, one notice and one Undo. What it names it
     * names by id, so it never needs a room. `reviewing`: the editor whose own Undo (Ctrl+Z) takes
     * it back.
     */
    const sendDiscard = (input: {
      all?: boolean;
      entries: readonly { draft: DraftReviewSelection; target: ChangeTarget }[];
      folders?: readonly string[];
      /** The folder the selection is, for the notice. */
      name?: string | null;
      surface: NoticeSurface;
      reviewing?: Editor | null;
    }): CommandStart => {
      endNotice();
      const { entries, folders = [] } = input;
      const [first] = entries;
      const branchId =
        queryClient.getQueryData<ThreadDraftListResponse>(
          projectQueryKeys.ownerDrafts(projectId, ownerKey),
        )?.branchId ?? (first ? branchOf(first.draft.itemKey) : null);
      if (locked || !branchId || (entries.length === 0 && folders.length === 0)) return blocked();
      const commandId = crypto.randomUUID();
      // One item per document: two targets on a document are one item with both.
      const taken = new Map<
        string,
        {
          draft: DraftReviewSelection;
          tree: boolean;
          text: "all" | string[] | null;
          seen?: FrameCut;
          hides: boolean;
        }
      >();
      for (const { draft, target } of entries) {
        const item = row(draft);
        const own =
          target.kind === "draft"
            ? { tree: true, text: "all" as const }
            : target.kind === "tree"
              ? { tree: true, text: null }
              : { tree: Boolean(target.tree), text: [...target.groupIds] };
        const held = taken.get(draft.documentId);
        taken.set(draft.documentId, {
          draft,
          ...(held?.seen
            ? { seen: held.seen }
            : target.kind === "groups"
              ? { seen: frameCut(target.frame) }
              : {}),
          tree: (held?.tree ?? false) || own.tree,
          text:
            held?.text === "all" || own.text === "all"
              ? "all"
              : held?.text || own.text
                ? [...(held?.text ?? []), ...(own.text ?? [])]
                : null,
          hides: Boolean(item?.isNew) && target.kind === "draft",
        });
      }
      const documentIds = [...taken.keys()];
      const refs = [...taken.values()].map(({ draft }) => ref(draft));
      const folderRefs = folders.map((node) => ({
        projectId,
        ownerKey,
        documentId: node,
        itemKey: folderKey(branchId, node),
      }));
      // A move or delete goes from the list at once; the refetch restores it if the server refused.
      for (const { draft, tree, text } of taken.values()) {
        const item = row(draft);
        if (item && tree && !text) dropTaken(item, { tree: true, text: false });
      }
      const outcome = owner
        .discard({
          projectId,
          branchId,
          commandId,
          selection: input.all
            ? { all: true, refs: [...refs, ...folderRefs] }
            : {
                items: [
                  ...[...taken.values()].map(({ draft, tree, text, seen, hides }) => ({
                    ref: ref(draft),
                    tree,
                    text,
                    ...(seen ? { seen } : {}),
                    hides,
                  })),
                  ...folderRefs.map((folderRef) => ({
                    ref: folderRef,
                    tree: true,
                    text: "all" as const,
                    hides: true,
                  })),
                ],
              },
        })
        .then((answer) => {
          // A whole item that left review leaves the list at once; the refetch confirms it.
          const ended = new Set(
            [...taken.values()].flatMap(({ draft, text }) =>
              (input.all || text === "all") && leftReview(answer) ? [draft.itemKey] : [],
            ),
          );
          if (ended.size)
            patchOwnerDrafts(queryClient, projectId, ownerKey, (rows) =>
              rows.filter((listed) => !ended.has(listed.itemKey)),
            );
          refresh(documentIds);
          return answer;
        });
      const handle = serverUndo(branchId, commandId, documentIds);
      void outcome.then((answer) => {
        answeredShare(handle, answer);
        refreshWorksIfReturned(answer);
      });
      const count = documentIds.length + folders.length;
      const only = count === 1 && first && folders.length === 0 ? row(first.draft) : undefined;
      const shown = notices.showDiscard({
        projectId,
        ownerKey,
        surface: input.surface,
        parts: [
          {
            documentId: first?.draft.documentId ?? folders[0] ?? "",
            covers: [...documentIds, ...folders],
            ...(input.name
              ? { name: input.name, scope: "folder" as const }
              : {
                  name: titleOf(first ? row(first.draft) : undefined) ?? t`Untitled document`,
                  scope: first?.target.kind === "groups" && count === 1 ? "change" : "draft",
                  ...(count === 1 ? {} : { count }),
                }),
            handle,
            restore: commandId,
            ...(only ? { review: reviewOf(only) } : {}),
            // The row comes back with the prose, once the server lists the draft again: a page
            // opened on it before then would close.
            undone: async () => {
              if (only)
                patchOwnerDrafts(queryClient, projectId, ownerKey, (rows) =>
                  rows.some((listed) => listed.itemKey === only.itemKey) ? rows : [...rows, only],
                );
              const listed = only
                ? await relistedOwnerDraft(queryClient, projectId, ownerKey, only.itemKey)
                : true;
              refresh(documentIds);
              return listed;
            },
          },
        ],
      });
      // A draft-only page (live deleted it elsewhere) has nothing left to show once its draft is
      // discarded: main goes back to the document it showed before, and the notice follows it there.
      if (
        removal &&
        first?.target.kind === "draft" &&
        count === 1 &&
        (draftOnly?.isDraftOnly(projectId, first.draft.documentId) ?? false)
      )
        void outcome.then((answer) => {
          if (answer.kind !== "done") return;
          removal.beginOwnRemoval(projectId, [first.draft.documentId], (landing) => {
            if (shown !== null) notices.landed(ownerKey, shown, landing);
          });
        });
      // Ctrl+Z in the editor that reviews it takes it back, as an entry that names the command.
      const history = editorHistoryOf(input.reviewing);
      const entry = history?.captureApply({
        undo: async () => {
          const restored = await handle.undo();
          if (restored.answer === "failed") return false;
          entry?.remove();
          return true;
        },
        redo: () => {},
      });
      void outcome.then((answer) => {
        if (answer.kind !== "done") entry?.remove();
      });
      return { sent: true, outcome };
    };
    const start = (
      mode: "apply" | "discard",
      draft: DraftReviewSelection,
      target: ChangeTarget,
    ): CommandStart => {
      if (mode === "apply") return applyOne(draft, target);
      return sendDiscard({
        entries: [{ draft, target }],
        surface: noticeSurface(draft),
        reviewing: reviewEditor ? reviewEditor(draft) : null,
      });
    };
    /** Several Discards as one command with one notice and one Undo. */
    const discardMany = (
      items: readonly { draft: DraftReviewSelection; target: ChangeTarget }[],
    ): Promise<CommandOutcome[]> => {
      const [first] = items;
      if (!first) return Promise.resolve([]);
      return sendDiscard({ entries: items, surface: noticeSurface(first.draft) }).outcome.then(
        (outcome) => [outcome],
      );
    };
    /**
     * A Discard of a selection: whole drafts and folder changes, or everything (`all`). Its notice's
     * Undo is the Restore of that command, which brings both halves back. `name`: the folder the
     * selection is, for the notice.
     */
    const discardSelection = (input: {
      all?: boolean;
      drafts: readonly DraftReviewSelection[];
      folders: readonly string[];
      name: string | null;
    }): Promise<CommandOutcome> => {
      const [first] = input.drafts;
      return sendDiscard({
        ...(input.all ? { all: true } : {}),
        entries: input.drafts.map((draft) => ({ draft, target: { kind: "draft" as const } })),
        folders: input.folders,
        name: input.name,
        surface: first ? noticeSurface(first) : { kind: "changes" },
      }).outcome;
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
      /** The Work the commands act for; No Work for a chat's own drafts. */
      work,
      ownerKey,
      threadId,
      owner,
      /** No owner to act on. A closed Work is not locked: its Apply lands, its Discard bounces. */
      dispositionLocked: locked,
      /** A frozen owner's draft takes no single-change command: only the whole draft's Discard. */
      changesLocked: locked || frozen,
      /** The owner's drafts are frozen (`ThreadDraftListResponse.frozen`): read-only, no Apply. */
      frozen,
      /**
       * Whether Apply is offered at all. A frozen owner (a lineage with every chat in Trash)
       * takes no Apply, so every surface hides it; a closed Work's Apply lands as any other.
       */
      canApply: !frozen,
      commandChange,
      startDraft,
      apply: (documentId: string, itemKey: string) =>
        startDraft("apply", { documentId, itemKey }).outcome,
      discard: (documentId: string, itemKey: string) =>
        startDraft("discard", { documentId, itemKey }).outcome,
      applyMany,
      discardMany,
      discardSelection,
      /** Discard all: every change of the branch, the one Discard that closes it. */
      discardAll: (
        drafts: readonly DraftReviewSelection[],
        folders: readonly string[],
        name: string | null,
      ) => discardSelection({ all: true, drafts, folders, name }),
    };
  }, [
    owner,
    registry,
    notices,
    removal,
    draftOnly,
    treeLists,
    locked,
    frozen,
    projectId,
    ownerKey,
    threadId,
    surface,
    reviewEditor,
    queryClient,
    work,
    created,
    closed,
  ]);
}

/**
 * The one Undo of a Discard: the notice's Undo, Trash's Restore and an editor's Restore all send
 * it. A fresh command id each time: a resend of a stored refusal would only replay it. Every draft
 * list is read again (a Trash entry names its Work, not the owner a surface reads); `documentIds`:
 * the documents it touched.
 */
export async function restoreDiscard(
  queryClient: QueryClient,
  input: {
    projectId: string;
    branchId: string;
    discardCommandId: string;
    documentIds: readonly string[];
  },
): Promise<RestoreAnswer> {
  const { projectId } = input;
  try {
    const answer = await undoDiscard(projectId, input.branchId, {
      commandId: crypto.randomUUID(),
      discardCommandId: input.discardCommandId,
    });
    refreshTurnCards(queryClient);
    void queryClient.invalidateQueries({ queryKey: projectQueryKeys.trashDiscards(projectId) });
    void queryClient.invalidateQueries({ queryKey: projectQueryKeys.ownerDraftsOf(projectId) });
    void queryClient.invalidateQueries({ queryKey: projectQueryKeys.draftMetadataOf(projectId) });
    for (const documentId of input.documentIds) {
      void queryClient.invalidateQueries({
        queryKey: projectQueryKeys.documentDraftHints(projectId, documentId),
      });
    }
    if (answer.status === "conflict") return { answer: "failed" };
    // A restore that brought nothing back (a closed owner, a restore that took it first, an entry
    // Trash no longer holds, or changes the writer has since written over) says nothing.
    if (answer.settled?.some((one) => one.rule === "returned"))
      void queryClient.invalidateQueries({ queryKey: projectQueryKeys.works(projectId) });
    return answer.restored > 0
      ? { answer: "ok", brought: answer.brought, branchId: answer.branchId }
      : { answer: "gone" };
  } catch {
    return { answer: "failed" };
  }
}

/** A draft's review, for a view following an Undo back to it. */
const reviewOf = (item: ThreadDraftListItem): ReviewFileTarget => ({
  documentId: item.documentId,
  documentName: item.documentName,
  contextLocation: item.contextLocation,
  draft: item,
  draftOnly: item.isNew || item.deletedLive,
});

/**
 * Discards these documents of a Work's branch as one command (`DraftCommandOwner.discard`): the
 * Undo of a restore made from Trash, which puts them back in Trash as a new entry. `tree: false`
 * leaves a document's move or delete alone.
 */
export async function discardDrafts(
  queryClient: QueryClient,
  owner: DraftCommandOwner,
  input: {
    projectId: string;
    ownerKey: string;
    branchId: string;
    items: readonly { documentId: string; tree: boolean; text: boolean }[];
  },
): Promise<CommandOutcome> {
  const { projectId, ownerKey, branchId } = input;
  const outcome = await owner.discard({
    projectId,
    branchId,
    commandId: crypto.randomUUID(),
    selection: {
      items: input.items.map(({ documentId, tree, text }) => ({
        ref: {
          projectId,
          ownerKey,
          documentId,
          itemKey: draftItemKey(branchId as BranchId, documentId),
        },
        tree,
        text: text ? ("all" as const) : null,
        hides: false,
      })),
    },
  });
  refreshTurnCards(queryClient);
  void queryClient.invalidateQueries({ queryKey: projectQueryKeys.trashDiscards(projectId) });
  void queryClient.invalidateQueries({
    queryKey: projectQueryKeys.ownerDrafts(projectId, ownerKey),
  });
  void queryClient.invalidateQueries({ queryKey: projectQueryKeys.draftMetadataOf(projectId) });
  return outcome;
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

/** The folder part of a document's address; null for none. */
const folderOf = (uri: string | null | undefined) =>
  uri ? uri.slice(0, uri.lastIndexOf("/") + 1) : null;
