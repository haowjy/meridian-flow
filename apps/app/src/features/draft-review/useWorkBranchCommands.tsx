/** Work-scoped authority over the account command owner; its notices live in the owner (`DraftNotices`). */

import { t } from "@lingui/core/macro";
import { type BranchId, draftItemKey, parseDraftItemKey } from "@meridian/contracts";
import type { ThreadDraftListItem, ThreadDraftListResponse } from "@meridian/contracts/branches";
import type { DocumentId } from "@meridian/contracts/runtime";
import { type Work, workLifecycleState } from "@meridian/contracts/works";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import type { Editor } from "@tiptap/core";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import { unapplyCommand, undoDiscard } from "@/client/api/branches-api";
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
  dropUndoStep,
  endWhenTakenBack,
  pushUndoStep,
  shownSourceOf,
} from "@/core/project-tree/tree-undo";
import { draftTreeVersion } from "@/core/project-tree/tree-version";
import type { TreeListSession } from "@/core/tree-list/tree-list-session";
import {
  useDraftCommandOwner,
  useLiveDocumentSessionRegistry,
  useOptionalContextRemovalCoordinator,
  useOptionalDraftOnlyPresentations,
  useOptionalTreeLists,
} from "@/features/project/context/account-feature-context";
import { useClosedOwners } from "@/features/project/context/closed-owners";
import { AppliedCommand, type ApplyInit, type Seat, serverPort } from "./apply-history";
import { type CommandOutcome, type DraftCommandOwner, folderKey } from "./draft-command-owner";
import {
  type AppliedFact,
  type AppliedUndo,
  type ApplyHalves,
  type DiscardPart,
  type DiscardUndo,
  type DiscardUndoAnswer,
  halvesOf,
  type NoticeSurface,
  returnedIn,
  unappliedOf,
} from "./draft-notices";
import type { DraftReviewSelection } from "./draft-review-session";
import type { ChangeTarget } from "./review-model";

export type BranchCommandOutcome = CommandOutcome;
/** What an Apply that landed landed, which its Undo step is made of. */
type StepData = {
  commandId: string;
  branchId: string;
  nodes: readonly string[];
  name: string;
  halves?: ApplyHalves;
};
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
    const liveHistory = (documentId: string) => registry.liveHistory(documentId as DocumentId);
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
    const leftReview = (answer: CommandOutcome, itemKey: string) =>
      (answer.kind === "done" || answer.kind === "settled") && !owner.state(itemKey).failure;
    /** The list item's draft, which an Apply of the whole draft names when no room is open. */
    const withDraft = (
      target: ChangeTarget,
      item: ThreadDraftListItem | undefined,
    ): ChangeTarget =>
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
    /**
     * The one place a closed owner's `returned` answer becomes a notice: the chip on the control
     * pressed (`documentIds`: its rows; none: the bar's), and the Works list read again, since
     * the writer's view of the Work was stale.
     */
    const bounced = (
      outcomes: readonly CommandOutcome[],
      surface: NoticeSurface,
      documentIds: readonly string[],
    ) => {
      const returned = outcomes.find((outcome) => outcome.kind === "returned");
      if (returned?.kind !== "returned") return;
      void queryClient.invalidateQueries({ queryKey: projectQueryKeys.works(projectId) });
      notices.showBounce({ projectId, ownerKey, surface, documentIds, why: returned.why });
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
      step: AppliedUndo | null,
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
      let fresh: AppliedFact[] = [
        ...done.flatMap(({ item, outcome }) => {
          const name = titleOf(item);
          return outcome.restored && name && item
            ? [
                {
                  documentId: item.documentId,
                  kind: "restored" as const,
                  name,
                  scheme: item.contextLocation?.scheme ?? null,
                },
              ]
            : [];
        }),
        ...said.flatMap((fact): AppliedFact[] => {
          const documentId = parseDraftItemKey(fact.itemKey)?.documentId;
          if (!documentId) return [];
          const { transition } = fact;
          // A document the Apply put somewhere new says where: a new one would look lost otherwise.
          if (
            picked.has(fact.itemKey) &&
            transition?.to &&
            folderOf(transition.from) !== folderOf(transition.to)
          )
            return [
              {
                documentId,
                kind: "landed",
                uri: transition.to,
                name: documentBasename(transition.to) ?? "",
              },
            ];
          if (picked.has(fact.itemKey)) return [];
          const from = documentBasename(transition?.from);
          const to = documentBasename(transition?.to);
          return from && to ? [{ documentId, kind: "also", from, to }] : [];
        }),
      ];
      // A document brought back somewhere new says only where it is now.
      const landedIds = new Set(
        fresh.flatMap((fact) => (fact.kind === "landed" ? [fact.documentId] : [])),
      );
      fresh = fresh.filter((fact) => fact.kind !== "restored" || !landedIds.has(fact.documentId));
      // Every document the writer applied says so on its row, a plain Apply as much as one that
      // moved it.
      const told = new Set(fresh.map((fact) => fact.documentId));
      for (const { item } of done) {
        const name = titleOf(item);
        if (item && name && !told.has(item.documentId)) {
          told.add(item.documentId);
          fresh.push({
            documentId: item.documentId,
            kind: "applied",
            name,
            scheme: item.contextLocation?.scheme ?? null,
          });
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
      const halves = data.halves ?? { text: true, tree: true, restores: [], did: {} };
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
      const init: ApplyInit = {
        sources: [...new Set(data.nodes.flatMap((node) => shownSourceOf(shown, node) ?? []))],
        name: data.name,
        nodes: data.nodes,
        facts: new Map(
          data.nodes.map((node) => [
            node,
            { did: halves.did[node] ?? null, folder: shown.nodes.get(node)?.kind === "folder" },
          ]),
        ),
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
     * The sidebar stack's seat for an Apply: on it, with a watch that ends its tree half once
     * nothing of it stands (a card's Undo of its rename). `account()`: a node of it is in the
     * account's list, which the watch reads too. Leaving ends the watch and the step's notice; a
     * newer Apply's notice stays.
     */
    const seatOn = (session: TreeListSession, account: () => boolean): Seat => ({
      session,
      enter: (step) => {
        const accountList = account() && treeLists ? treeLists.acquire(treeLists.account) : null;
        pushUndoStep(session, step);
        const stopWatch = endWhenTakenBack(
          accountList ? [session, accountList.session] : [session],
          step,
        );
        return () => {
          stopWatch();
          accountList?.release();
          dropUndoStep(session, step);
          if (notices.appliedFacts(ownerKey)?.facts.some((fact) => fact.step?.command === step))
            endNotice();
        };
      },
    });
    /**
     * An Apply goes on the sidebar's Undo stack as one step (`AppliedCommand`): its Undo is the
     * server's Un-Apply of the whole command, fact by fact: what changed since stays, what a closed
     * owner holds waits in its place, and otherwise the step is spent once pressed. The editors
     * open on its documents show the same step, and their Redo is `again`, whose Apply the step
     * becomes. A band's Apply has its editor's Undo instead, and comes onto the stack only when it
     * holds a tree change (`joinStack`).
     */
    const rememberApply = (
      data: StepData,
      again: (step: AppliedCommand) => Promise<StepData | null>,
    ): AppliedCommand | null => {
      const made = stepOf(data);
      if (!made) return null;
      let { documentIds, account } = made;
      let { branchId } = data;
      const port = serverPort({
        commandId: data.commandId,
        unapply: (body) => unapplyCommand(projectId, branchId, body),
        heard: async (answer) => {
          refresh(documentIds);
          // The Apply's notice ends once the list has the Work's row back: the list the Apply
          // left has none, so ending it earlier leaves the writer no row until the read lands.
          await queryClient.refetchQueries(
            { queryKey: projectQueryKeys.ownerDrafts(projectId, ownerKey) },
            { cancelRefetch: false },
          );
          if (unappliedOf(answer).taken !== "nothing")
            for (const documentId of documentIds) owner.forgetApplyFacts(projectId, documentId);
        },
        again: async () => {
          const landed = await again(step);
          const next = landed && stepOf(landed);
          if (!landed || !next) return null;
          ({ documentIds, account, branchId } = { ...next, branchId: landed.branchId });
          return { commandId: landed.commandId, init: next.init };
        },
      });
      const step: AppliedCommand = new AppliedCommand(
        made.init,
        port,
        () => documentIds.map(liveHistory),
        {
          closed,
          seat: seatOn(made.session, () => account),
          said: ({ from, answer, step }) =>
            notices.showPress({
              projectId,
              ownerKey,
              documentId:
                documentIds.find((id) => liveHistory(id) === from) ?? documentIds[0] ?? "",
              step,
              answer,
            }),
          over: () => owner.applied.delete(step),
        },
      );
      owner.applied.add(step);
      return step;
    };
    /** The applied rows' Undo: `step`, the one Ctrl+Z takes, over the changes it landed. */
    const undoOf = (step: AppliedCommand | null, data: StepData | null): AppliedUndo | null =>
      step && data ? { command: step, count: data.nodes.length } : null;
    /**
     * `redone`: the Apply whose Redo this is, which becomes this Apply's step. `landed`: what it
     * landed, null when nothing did.
     */
    const applyOne = (
      draft: DraftReviewSelection,
      target: ChangeTarget,
      redone?: AppliedCommand,
    ): CommandStart & { landed: Promise<StepData | null> } => {
      endNotice();
      const item = row(draft);
      const tree = target.kind === "tree" || target.kind === "draft" || target.tree;
      const started = locked
        ? null
        : owner.apply(
            ref(draft),
            withDraft(target, item),
            Boolean(tree && item?.tree),
            sawNow(),
            surface === "band"
              ? {
                  histories: () => [
                    editorHistoryOf(reviewEditor?.(draft)),
                    liveHistory(draft.documentId),
                  ],
                  closed,
                }
              : null,
          );
      if (!started) return { ...blocked(), landed: Promise.resolve(null) };
      const landed = started.outcome.then((outcome) => {
        if (outcome.kind === "done" && item)
          dropTaken(item, {
            tree: Boolean(outcome.treeWhole && tree && item.tree),
            text: target.kind === "draft" && (outcome.halves?.text ?? true),
          });
        const name = titleOf(item) ?? t`Untitled document`;
        const band = started.band;
        // A band's Apply is its editors' Undo; the sidebar takes only a tree fact it held.
        if (band && outcome.kind === "done" && item) {
          band.name = name;
          band.joinStack = () => {
            const made = stepOf({
              commandId: band.commandId,
              branchId: item.branchId,
              nodes: [draft.documentId],
              name,
              halves: {
                text: band.text,
                tree: true,
                restores: outcome.halves?.restores ?? [],
                did: outcome.halves?.did ?? {},
              },
            });
            if (!made) return;
            const { tree, sources, facts } = made.init;
            band.placeOn(
              seatOn(made.session, () => made.account),
              { tree, sources, facts },
            );
          };
        }
        const data: StepData | null =
          !band && outcome.kind === "done" && outcome.commandId && item
            ? {
                commandId: outcome.commandId,
                branchId: item.branchId,
                nodes: [draft.documentId],
                name,
                halves: outcome.halves,
              }
            : null;
        const step =
          redone ?? (data && rememberApply(data, (step) => applyOne(draft, target, step).landed));
        if (outcome.kind === "done") applied(draft, [{ item, outcome }], undoOf(step, data));
        if (!owner.state(draft.itemKey).pending) refresh([draft.documentId]);
        return data;
      });
      return { ...started, landed };
    };
    /**
     * Several drafts and folders as one Apply command, one step of Undo: Apply all, a folder's ✓.
     * `folders`: the folder changes it takes, with what is listed under them. `redone`: the
     * Apply whose Redo this is. `outcomes` resolves to each item's outcome; `landed` to what the
     * command landed, once its Undo step is kept, or null when nothing landed.
     */
    const applyGroup = (
      items: readonly { draft: DraftReviewSelection; target: ChangeTarget }[],
      folders: readonly string[] = [],
      name?: string,
      redone?: AppliedCommand,
    ): { outcomes: Promise<CommandOutcome[]>; landed: Promise<StepData | null> } => {
      endNotice();
      const listed = queryClient.getQueryData<ThreadDraftListResponse>(
        projectQueryKeys.ownerDrafts(projectId, ownerKey),
      );
      const branchId = listed?.branchId;
      if (locked || !branchId)
        return {
          outcomes: Promise.resolve(items.map(() => ({ kind: "blocked" as const }))),
          landed: Promise.resolve(null),
        };
      const members = items.map(({ draft, target }) => {
        const item = row(draft);
        const tree = target.kind === "tree" || target.kind === "draft" || target.tree;
        return { draft, item, target: withDraft(target, item), tree: Boolean(tree && item?.tree) };
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
      const landed = Promise.all([outcomes, Promise.all(started.outcomes), started.answer]).then(
        ([settled, _all, answer]) => {
          // The step is what the answer says landed, not what was pressed: an item settled
          // before it (an earlier Discard's, another Apply's) is no part of its Undo.
          const landed = answer?.status === "applied" ? answer : null;
          const taken =
            landed?.items.flatMap((item) =>
              item.tree?.landed || item.text?.landed ? [item.node] : [],
            ) ?? [];
          const only =
            taken.length === 1
              ? titleOf(members.find((m) => m.draft.documentId === taken[0])?.item)
              : null;
          const count = taken.length;
          // Only an Apply that landed something is a step: Ctrl+Z would take an empty one.
          const data: StepData | null =
            count > 0 && landed
              ? {
                  commandId: landed.commandId,
                  branchId,
                  nodes: taken,
                  name: name ?? only ?? t`${count} changes`,
                  halves: halvesOf(landed),
                }
              : null;
          const step =
            redone ??
            (data && rememberApply(data, (step) => applyGroup(items, folders, name, step).landed));
          if (first)
            applied(
              first.draft,
              settled.flatMap((outcome, index) =>
                outcome.kind === "done" ? [{ item: members[index]?.item, outcome }] : [],
              ),
              undoOf(step, data),
            );
          if (folders.length > 0) refresh([]);
          return data;
        },
      );
      return { outcomes, landed };
    };
    const applyMany = (
      items: readonly { draft: DraftReviewSelection; target: ChangeTarget }[],
      folders: readonly string[] = [],
      name?: string,
    ): Promise<CommandOutcome[]> => applyGroup(items, folders, name).outcomes;
    /**
     * The Undo of a Discard the server ran: its Undo command, which brings both halves back, sent
     * through the one restore progress Trash and the editor read.
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
    const start = (
      mode: "apply" | "discard",
      draft: DraftReviewSelection,
      target: ChangeTarget,
    ): CommandStart => {
      return mode === "apply" ? applyOne(draft, target) : discardOne(draft, target);
    };
    const discardOne = (draft: DraftReviewSelection, target: ChangeTarget): CommandStart => {
      // A new Discard replaces the owner's notice, with its own or with none.
      endNotice();
      // A draft-only page (live deleted it elsewhere) has nothing left to show once its draft is
      // discarded: once the Discard is written, here or on the server, main goes back to the
      // document it showed before, and a notice follows it there. A refused Discard leaves main
      // on the page, which shows the refusal.
      const leaves =
        target.kind === "draft" && (draftOnly?.isDraftOnly(projectId, draft.documentId) ?? false);
      const { start, parts } = dispatchDiscard(draft, target);
      // A change card's chip stays on the card pressed; a whole draft's is the band's.
      const bounceSurface: NoticeSurface =
        surface === "band" && target.kind === "groups"
          ? { kind: "card", documentId: draft.documentId }
          : noticeSurface(draft);
      void start.outcome.then((outcome) => bounced([outcome], bounceSurface, [draft.documentId]));
      const shown = notices.showDiscard({
        projectId,
        ownerKey,
        surface: noticeSurface(draft),
        bounceSurface,
        parts,
      });
      if (leaves && removal)
        void start.outcome.then((outcome) => {
          if (outcome.kind !== "done") return;
          removal.beginOwnRemoval(projectId, [draft.documentId], (landing) => {
            if (shown !== null) notices.landed(ownerKey, shown, landing);
          });
        });
      return start;
    };
    /** Several Discards as one notice with one Undo. */
    const discardMany = (
      items: readonly { draft: DraftReviewSelection; target: ChangeTarget }[],
    ): Promise<CommandOutcome[]> => {
      endNotice();
      const started = items.map(({ draft, target }) => dispatchDiscard(draft, target));
      const parts = started.flatMap(({ parts }) => parts);
      const [first] = items;
      const outcomes = Promise.all(started.map(({ start }) => start.outcome));
      if (first) {
        const surface = noticeSurface(first.draft);
        notices.showDiscard({ projectId, ownerKey, surface, parts });
        void outcomes.then((settled) =>
          bounced(
            settled,
            surface,
            items.map(({ draft }) => draft.documentId),
          ),
        );
      }
      return outcomes;
    };
    /**
     * One Discard and its share of the notice's Undo. A whole draft is one server command, which
     * Trash lists and its Undo brings back; a move or delete is one too, with the chosen changes'
     * text written here; changes alone are text written in the room, whose Undo the room holds.
     */
    const dispatchDiscard = (
      draft: DraftReviewSelection,
      target: ChangeTarget,
    ): { start: CommandStart; parts: DiscardPart[] } => {
      const none = (start: CommandStart) => ({ start, parts: [] });
      if (locked) return none(blocked());
      const item = row(draft);
      const history = reviewEditor ? reviewEditor(draft) : "notice";
      const name = titleOf(item) ?? t`Untitled document`;
      const scope = target.kind === "draft" ? ("draft" as const) : ("change" as const);
      /** A server command's share of the notice: its answer says what of it stays. */
      const share = (handle: DiscardUndo, outcome: Promise<CommandOutcome>): DiscardPart => {
        void outcome.then((answer) => answeredShare(handle, answer));
        return { documentId: draft.documentId, name, scope, handle };
      };
      // A whole draft ends on the server, everything it holds.
      if (target.kind === "draft") {
        if (!item) return none(blocked());
        const commandId = crypto.randomUUID();
        const outcome = owner.discardOnServer(ref(draft), item, commandId).then((answer) => {
          if (leftReview(answer, item.itemKey))
            patchOwnerDrafts(queryClient, projectId, ownerKey, (rows) =>
              rows.filter((listed) => listed.itemKey !== item.itemKey),
            );
          refresh([draft.documentId]);
          return answer;
        });
        return {
          start: { sent: true, outcome },
          parts: [
            {
              ...share(serverUndo(item.branchId, commandId, [draft.documentId]), outcome),
              restore: commandId,
              review: reviewOf(item),
              // A view following the Undo opens the draft once the server lists it again.
              undone: () => relistedOwnerDraft(queryClient, projectId, ownerKey, item.itemKey),
            },
          ],
        };
      }
      // A move or delete is discarded on the server, with the item's chosen text, as one command.
      if (target.kind === "tree" || (target.kind === "groups" && target.tree)) {
        if (!item?.tree) return none(blocked());
        const commandId = crypto.randomUUID();
        const discarded = owner.discardItem(ref(draft), item, target, history, commandId);
        if (!discarded) return none(blocked());
        // The line goes at once; the refetch after the answer restores it if the server refused.
        dropTaken(item, { tree: true, text: false });
        const outcome = discarded.outcome.then((answer) => {
          refresh([draft.documentId]);
          return answer;
        });
        // Two shares of one Undo: the room's text, and the server's command, which its answer
        // narrows like any other (an Apply that took the item first leaves only the text).
        const server: DiscardPart = {
          ...share(serverUndo(item.branchId, commandId, [draft.documentId]), discarded.tree),
          restore: commandId,
        };
        return {
          start: { sent: true, outcome },
          parts: discarded.handle
            ? [{ documentId: draft.documentId, name, scope, handle: discarded.handle }, server]
            : [server],
        };
      }
      const discarded = owner.discard(ref(draft), target, history);
      if (!discarded) return none(blocked());
      void discarded.outcome.then(() => refresh([draft.documentId]));
      const start = { sent: true, outcome: discarded.outcome };
      if (!discarded.handle) return none(start);
      return {
        start,
        parts: [
          {
            documentId: draft.documentId,
            name,
            scope,
            handle: discarded.handle,
            ...(item ? { review: reviewOf(item) } : {}),
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
              const listed = await relistedOwnerDraft(
                queryClient,
                projectId,
                ownerKey,
                item.itemKey,
              );
              refresh([draft.documentId]);
              return listed;
            },
          },
        ],
      };
    };
    /**
     * A Discard of a selection as one server command over exactly those items: whole drafts
     * (their text and tree changes) and folder changes, with what stands on them. A folder group's
     * × and a folder changed alone send it; only Discard all (`all`) takes the whole branch. Its
     * notice's Undo is the server's Undo of that Discard, which brings both halves back. `name`:
     * the folder the selection is, for the notice.
     */
    const discardSelection = (input: {
      all?: boolean;
      drafts: readonly DraftReviewSelection[];
      folders: readonly string[];
      name: string | null;
    }): Promise<CommandOutcome> => {
      endNotice();
      const listed = queryClient.getQueryData<ThreadDraftListResponse>(
        projectQueryKeys.ownerDrafts(projectId, ownerKey),
      );
      const branchId = listed?.branchId;
      const { folders } = input;
      if (locked || !branchId || (input.drafts.length === 0 && folders.length === 0))
        return Promise.resolve({ kind: "blocked" });
      const commandId = crypto.randomUUID();
      const documentIds = input.drafts.map((draft) => draft.documentId);
      const refs = input.drafts.map(ref);
      const folderRefs = folders.map((node) => ({
        projectId,
        ownerKey,
        documentId: node,
        itemKey: folderKey(branchId, node),
      }));
      const outcome = owner
        .discardBranch({
          projectId,
          branchId,
          commandId,
          selection: input.all
            ? { all: true, refs: [...refs, ...folderRefs] }
            : {
                items: [
                  ...input.drafts.map((draft) => ({ ref: ref(draft), ends: "item" as const })),
                  ...folderRefs.map((folderRef) => ({ ref: folderRef, ends: "item" as const })),
                ],
              },
        })
        .then((answer) => {
          const ended = new Set(
            input.drafts.flatMap((draft) =>
              leftReview(answer, draft.itemKey) ? [draft.itemKey] : [],
            ),
          );
          patchOwnerDrafts(queryClient, projectId, ownerKey, (rows) =>
            rows.filter((listed) => !ended.has(listed.itemKey)),
          );
          refresh(documentIds);
          return answer;
        });
      const handle = serverUndo(branchId, commandId, documentIds);
      void outcome.then((answer) => answeredShare(handle, answer));
      const [first] = input.drafts;
      const count = input.drafts.length + folders.length;
      const surface: NoticeSurface = first ? noticeSurface(first) : { kind: "changes" };
      void outcome.then((answer) =>
        bounced([answer], surface, input.all ? [] : folders.slice(0, 1)),
      );
      notices.showDiscard({
        projectId,
        ownerKey,
        surface,
        parts: [
          {
            documentId: first?.documentId ?? folders[0] ?? "",
            covers: [...documentIds, ...folders],
            ...(input.name
              ? { name: input.name, scope: "folder" as const }
              : {
                  name: titleOf(first ? row(first) : undefined) ?? t`Untitled document`,
                  scope: "draft" as const,
                  count,
                }),
            handle,
            restore: commandId,
          },
        ],
      });
      return outcome;
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
): Promise<Omit<DiscardUndoAnswer, "landed"> & { branchId?: string }> {
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
    // A restore that brought nothing back says why: a closed owner, a restore that took it first,
    // or an entry Trash no longer holds.
    const closed = returnedIn(answer.settled);
    if (closed) {
      if (closed === "work-closed")
        void queryClient.invalidateQueries({ queryKey: projectQueryKeys.works(projectId) });
      return { answer: "returned", why: closed };
    }
    if (answer.restored > 0)
      return { answer: "ok", leftOut: answer.leftOut, branchId: answer.branchId };
    return answer.settled?.some((one) => one.rule === "already")
      ? { answer: "gone" }
      : { answer: "returned", why: "gone-from-trash" };
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
 * Discards these documents' drafts of a Work's branch as one command (`DraftCommandOwner
 * .discardBranch`, the one a selection's Discard sends): the Undo of a restore made from Trash,
 * which puts them back in Trash as a new entry.
 */
export async function discardDrafts(
  queryClient: QueryClient,
  owner: DraftCommandOwner,
  input: { projectId: string; ownerKey: string; branchId: string; documentIds: readonly string[] },
): Promise<CommandOutcome> {
  const { projectId, ownerKey, branchId } = input;
  const outcome = await owner.discardBranch({
    projectId,
    branchId,
    commandId: crypto.randomUUID(),
    selection: {
      items: input.documentIds.map((documentId) => ({
        ref: {
          projectId,
          ownerKey,
          documentId,
          itemKey: draftItemKey(branchId as BranchId, documentId),
        },
        ends: "item" as const,
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
