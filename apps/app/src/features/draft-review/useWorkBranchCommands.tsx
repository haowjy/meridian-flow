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
  ownerDraftsQueryOptions,
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
  pushUndoStep,
  shownSourceOf,
  undoApply,
} from "@/core/project-tree/tree-undo";
import { draftTreeVersion } from "@/core/project-tree/tree-version";
import {
  useDraftCommandOwner,
  useLiveDocumentSessionRegistry,
  useOptionalContextRemovalCoordinator,
  useOptionalDraftOnlyPresentations,
  useOptionalTreeLists,
} from "@/features/project/context/account-feature-context";
import { AppliedEntry } from "./apply-history";
import { isDeletedLive } from "./deleted-drafts";
import { type CommandOutcome, type DraftCommandOwner, folderKey } from "./draft-command-owner";
import type {
  AppliedFact,
  AppliedUndo,
  DiscardPart,
  DiscardUndo,
  DiscardUndoAnswer,
  NoticeSurface,
} from "./draft-notices";
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
  const registry = useLiveDocumentSessionRegistry();
  const queryClient = useQueryClient();
  // An archived or deleted Work's drafts show, and take no command until it is back.
  const locked = !ownerKey || !work || workLifecycleState(work) !== "active";
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
  return useMemo(() => {
    const ref = (draft: DraftReviewSelection) => ({ projectId, ownerKey, ...draft });
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
          if (picked.has(fact.itemKey)) {
            const name = fact.renamed ? documentBasename(fact.renamed) : null;
            return name ? [{ documentId, kind: "renamed", name }] : [];
          }
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
     * An Apply goes on the sidebar's Undo stack as one step (design §5): its Undo is the server's
     * Un-Apply of the whole command, which answers `refused` once anything changed since. The
     * editors open on its documents hold the same step, and their Redo is `again`; a Redo's
     * Apply hands its step to the `entry` it came from. A band's Apply has its editor's Undo
     * instead.
     */
    const rememberApply = (
      commandId: string,
      branchId: string,
      nodes: readonly string[],
      name: string,
      again: (entry: AppliedEntry) => Promise<void>,
      redone?: AppliedEntry,
    ): AppliedUndo | null => {
      if (surface === "band" || !treeLists) return null;
      const handle = treeLists.acquire({ kind: "project", projectId });
      const session = handle.session;
      // The Work's tree shows every node the Apply took, before it and after.
      const { view, pendingText } = draftTreeVersion(
        branchId,
        listed(),
        work ? workLifecycleState(work) : "active",
      );
      const shown = session.replay(view, pendingText);
      const documentIds = nodes.filter((node) => shown.nodes.get(node)?.kind !== "folder");
      // A resend after a lost answer names the same Un-Apply: the server answers it once.
      const unapplyId = crypto.randomUUID();
      let entry = redone ?? null;
      const unapplyOnServer = async (): Promise<Awaited<ReturnType<ApplyStep["unapply"]>>> => {
        try {
          const answer = await unapplyCommand(projectId, branchId, {
            commandId: unapplyId,
            applyCommandId: commandId,
          });
          if (answer.status === "conflict") return { answer: "failed" };
          refresh(documentIds);
          // The Apply's notice ends once the list has the Work's row back: the list the Apply
          // left has none, so ending it earlier leaves the writer no row until the read lands.
          await queryClient.refetchQueries(
            { queryKey: projectQueryKeys.ownerDrafts(projectId, ownerKey) },
            { cancelRefetch: false },
          );
          if (answer.status !== "unapplied") return { answer: "skipped" };
          for (const documentId of documentIds) owner.forgetApplyFacts(projectId, documentId);
          return { answer: "unapplied" };
        } catch {
          return { answer: "failed" };
        }
      };
      const step: ApplyStep = {
        kind: "apply",
        sources: [...new Set(nodes.flatMap((node) => shownSourceOf(shown, node) ?? []))],
        name,
        nodes,
        unapply: async () => {
          entry?.leaving(step);
          const said = await unapplyOnServer();
          entry?.answered(step, said.answer);
          // The press says what became of it on the rows (`TreeNotice`): the Apply's own words,
          // and its Undo, give way.
          if (notices.appliedFacts(ownerKey)) endNotice();
          return said;
        },
      };
      pushUndoStep(session, step);
      handle.release();
      if (entry) entry.follow(step);
      else entry = new AppliedEntry(session, step, () => documentIds.map(liveHistory), again);
      // The applied rows' Undo is this step, the one Ctrl+Z takes.
      return { undo: () => void undoApply(session, step), count: nodes.length };
    };
    /** `redone`: the editor entry whose Redo this Apply is. */
    const applyOne = (
      draft: DraftReviewSelection,
      target: ChangeTarget,
      redone?: AppliedEntry,
    ): CommandStart => {
      endNotice();
      const item = row(draft);
      const tree = target.kind === "tree" || target.kind === "draft" || target.tree;
      const started = locked
        ? null
        : owner.apply(
            ref(draft),
            target,
            isDeletedLive(item),
            (tree && item?.tree) || undefined,
            surface === "band"
              ? () => [editorHistoryOf(reviewEditor?.(draft)), liveHistory(draft.documentId)]
              : null,
          );
      if (!started) {
        redone?.retire();
        return blocked();
      }
      void started.outcome.then((outcome) => {
        if (outcome.kind === "done" && tree && item?.tree) dropTreeLine(item);
        const step =
          outcome.kind === "done" && outcome.commandId && item
            ? rememberApply(
                outcome.commandId,
                item.branchId,
                [draft.documentId],
                titleOf(item) ?? t`Untitled document`,
                (entry) => applyOne(draft, target, entry).outcome.then(() => undefined),
                redone,
              )
            : null;
        if (!step) redone?.retire();
        if (outcome.kind === "done") applied(draft, [{ item, outcome }], step);
        if (outcome.kind === "needs-restore" || !owner.state(draft.itemKey).pending)
          refresh([draft.documentId]);
      });
      return started;
    };
    /**
     * Several drafts and folders as one Apply command, one step of Undo: Apply all, a folder's ✓.
     * `restore`: the documents its confirmation named, which it brings back from a delete; it
     * brings back no other. `folders`: the folder changes it takes, with what is listed under
     * them. `redone`: the editor entry whose Redo this Apply is. `outcomes` resolves to each
     * item's outcome; `remembered` once its Undo step is kept, or none is.
     */
    const applyGroup = (
      items: readonly { draft: DraftReviewSelection; target: ChangeTarget }[],
      restore: ReadonlySet<string>,
      folders: readonly string[],
      name: string | undefined,
      redone?: AppliedEntry,
    ): { outcomes: Promise<CommandOutcome[]>; remembered: Promise<void> } => {
      endNotice();
      const listed = queryClient.getQueryData<ThreadDraftListResponse>(
        projectQueryKeys.ownerDrafts(projectId, ownerKey),
      );
      const branchId = listed?.branchId;
      if (locked || !branchId) {
        redone?.retire();
        return {
          outcomes: Promise.resolve(items.map(() => ({ kind: "blocked" as const }))),
          remembered: Promise.resolve(),
        };
      }
      const members = items.map(({ draft, target }) => {
        const item = row(draft);
        const tree = target.kind === "tree" || target.kind === "draft" || target.tree;
        return { draft, item, target, tree: (tree && item?.tree) || undefined };
      });
      // A folder changed alone lists no item, so the cached list may predate it: read it again.
      const revisions = async () => {
        const known = (response: ThreadDraftListResponse) =>
          folders.every((node) => response.folders.some((folder) => folder.id === node));
        const read = known(listed)
          ? listed
          : await queryClient.fetchQuery({
              ...ownerDraftsQueryOptions(projectId, ownerKey),
              staleTime: 0,
            });
        return new Map(read.folders.map((folder) => [folder.id, folder.revision]));
      };
      const started = owner.applyGroup({
        projectId,
        ownerKey,
        branchId,
        members: members.map(({ draft, target, tree }) => ({
          ref: ref(draft),
          target,
          restore: restore.has(draft.documentId),
          ...(tree ? { tree } : {}),
        })),
        folders,
        revisions,
        restore: restore.size > 0,
      });
      started.outcomes.forEach((outcome, index) => {
        const member = members[index];
        if (!member) return;
        void outcome.then((settled) => {
          if (settled.kind === "done" && member.tree && member.item) dropTreeLine(member.item);
          if (settled.kind === "needs-restore" || !owner.state(member.draft.itemKey).pending)
            refresh([member.draft.documentId]);
        });
      });
      const [first] = members;
      // A delete the writer wasn't shown holds the whole command back: the list read again says
      // which items live deleted, for the question asked next.
      const outcomes = Promise.all(started.outcomes.slice(0, members.length)).then(
        async (settled) => {
          if (!settled.some((outcome) => outcome.kind === "needs-restore")) return settled;
          await queryClient.refetchQueries({
            queryKey: projectQueryKeys.ownerDrafts(projectId, ownerKey),
          });
          return settled.map((outcome, index): CommandOutcome => {
            const member = members[index];
            return outcome.kind === "needs-restore" && member && isDeletedLive(row(member.draft))
              ? { kind: "needs-restore", deleted: true }
              : outcome;
          });
        },
      );
      const remembered = Promise.all([
        outcomes,
        Promise.all(started.outcomes),
        started.answer,
      ]).then(([settled, _all, answer]) => {
        const taken = [...members.map(({ draft }) => draft.documentId), ...folders];
        const only = members.length === 1 && folders.length === 0 ? titleOf(first?.item) : null;
        const count = taken.length;
        const step =
          answer?.status === "applied"
            ? rememberApply(
                answer.commandId,
                branchId,
                taken,
                name ?? only ?? t`${count} changes`,
                (entry) => applyGroup(items, restore, folders, name, entry).remembered,
                redone,
              )
            : null;
        if (!step) redone?.retire();
        if (first)
          applied(
            first.draft,
            settled.flatMap((outcome, index) =>
              outcome.kind === "done" ? [{ item: members[index]?.item, outcome }] : [],
            ),
            step,
          );
        if (folders.length > 0) refresh([]);
      });
      return { outcomes, remembered };
    };
    const applyMany = (
      items: readonly { draft: DraftReviewSelection; target: ChangeTarget }[],
      restore: ReadonlySet<string> = new Set(),
      folders: readonly string[] = [],
      name?: string,
    ): Promise<CommandOutcome[]> => applyGroup(items, restore, folders, name).outcomes;
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
    /** One share for a Discard that is a room's text and a server command together. */
    const bothUndo = (text: DiscardUndo | null, server: DiscardUndo): DiscardUndo =>
      text
        ? {
            undo: async () => {
              const shares = [text.undo(), server.undo()];
              const [own, theirs] = await Promise.all(shares);
              const answers = [own?.answer, theirs?.answer];
              return {
                answer: answers.includes("failed")
                  ? "failed"
                  : answers.includes("ok")
                    ? "ok"
                    : "gone",
                landed: Promise.all([own?.landed, theirs?.landed]).then(() => undefined),
                ...(theirs?.leftOut ? { leftOut: theirs.leftOut } : {}),
              };
            },
            end: () => text.end(),
          }
        : server;
    const start = (
      mode: "apply" | "discard",
      draft: DraftReviewSelection,
      target: ChangeTarget,
    ): CommandStart => {
      const started = mode === "apply" ? applyOne(draft, target) : discardOne(draft, target);
      void started.outcome.then((outcome) => {
        if (outcome.kind === "change-refused" && outcome.code === "work_archived")
          void queryClient.invalidateQueries({ queryKey: projectQueryKeys.works(projectId) });
      });
      return started;
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
      const parts = started.flatMap(({ part }) => (part ? [part] : []));
      const [first] = items;
      if (first)
        notices.showDiscard({ projectId, ownerKey, surface: noticeSurface(first.draft), parts });
      return Promise.all(started.map(({ start }) => start.outcome));
    };
    /**
     * One Discard and its share of the notice's Undo. A whole draft is one server command, which
     * Trash lists and its Undo brings back; a move or delete is one too, with the chosen changes'
     * text written here; changes alone are text written in the room, whose Undo the room holds.
     */
    const dispatchDiscard = (
      draft: DraftReviewSelection,
      target: ChangeTarget,
    ): { start: CommandStart; part: DiscardPart | null } => {
      const none = (start: CommandStart) => ({ start, part: null });
      if (locked) return none(blocked());
      const item = row(draft);
      const history = reviewEditor ? reviewEditor(draft) : "notice";
      const name = titleOf(item) ?? t`Untitled document`;
      const scope = target.kind === "draft" ? ("draft" as const) : ("change" as const);
      /** The notice's share; it leaves the notice when the Discard itself was refused. */
      const share = (
        handle: DiscardUndo,
        outcome: Promise<CommandOutcome>,
        ownText: boolean,
      ): DiscardPart => {
        void outcome.then((answer) => {
          if (answer.kind !== "done" && !ownText) notices.partEnded(handle);
        });
        return { documentId: draft.documentId, name, scope, handle };
      };
      // A whole draft ends on the server, everything it holds.
      if (target.kind === "draft") {
        if (!item) return none(blocked());
        const commandId = crypto.randomUUID();
        const outcome = owner
          .discardOnServer(ref(draft), item, frozen, commandId)
          .then((answer) => {
            if (answer.kind === "done")
              patchOwnerDrafts(queryClient, projectId, ownerKey, (rows) =>
                rows.filter((listed) => listed.itemKey !== item.itemKey),
              );
            refresh([draft.documentId]);
            return answer;
          });
        return {
          start: { sent: true, outcome },
          part: {
            ...share(serverUndo(item.branchId, commandId, [draft.documentId]), outcome, false),
            restore: commandId,
            review: reviewOf(item),
            // A view following the Undo opens the draft once the server lists it again.
            undone: () => relistedOwnerDraft(queryClient, projectId, ownerKey, item.itemKey),
          },
        };
      }
      // A move or delete is discarded on the server, with the item's chosen text, as one command.
      if (target.kind === "tree" || (target.kind === "groups" && target.tree)) {
        if (!item?.tree) return none(blocked());
        const commandId = crypto.randomUUID();
        const discarded = owner.discardItem(ref(draft), item, target, history, commandId);
        if (!discarded) return none(blocked());
        // The line goes at once; the refetch after the answer restores it if the server refused.
        dropTreeLine(item);
        const outcome = discarded.outcome.then((answer) => {
          refresh([draft.documentId]);
          return answer;
        });
        const handle = bothUndo(
          discarded.handle,
          serverUndo(item.branchId, commandId, [draft.documentId]),
        );
        return {
          start: { sent: true, outcome },
          part: { ...share(handle, outcome, discarded.handle !== null), restore: commandId },
        };
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
            const listed = await relistedOwnerDraft(queryClient, projectId, ownerKey, item.itemKey);
            refresh([draft.documentId]);
            return listed;
          },
        },
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
                  ...input.drafts.map((draft) => {
                    const item = row(draft);
                    return {
                      ref: ref(draft),
                      ends: "item" as const,
                      // A frozen owner's Discard names the drafts the writer saw.
                      ...(frozen && item
                        ? { draftSeenAt: item.hasDraft ? item.updatedAt : null }
                        : {}),
                    };
                  }),
                  ...folderRefs.map((folderRef) => ({ ref: folderRef, ends: "item" as const })),
                ],
              },
        })
        .then((answer) => {
          if (answer.kind === "done") {
            const ended = new Set(input.drafts.map((draft) => draft.itemKey));
            patchOwnerDrafts(queryClient, projectId, ownerKey, (rows) =>
              rows.filter((listed) => !ended.has(listed.itemKey)),
            );
          }
          refresh(documentIds);
          return answer;
        });
      const handle = serverUndo(branchId, commandId, documentIds);
      void outcome.then((answer) => {
        if (answer.kind !== "done") notices.partEnded(handle);
      });
      const [first] = input.drafts;
      const count = input.drafts.length + folders.length;
      notices.showDiscard({
        projectId,
        ownerKey,
        surface: first ? noticeSurface(first) : { kind: "changes" },
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
    if (answer.status === "restored")
      return { answer: "ok", leftOut: answer.leftOut, branchId: answer.branchId };
    if (answer.status === "conflict") return { answer: "failed" };
    switch (answer.reason) {
      case "already_restored":
      case "nothing_to_restore":
        return { answer: "gone" };
      case "work_archived":
      case "work_deleted":
        return { answer: "returned", why: "work-closed" };
      case "chat_frozen":
        return { answer: "returned", why: "chat-in-trash" };
      default:
        return { answer: "returned", why: "gone-from-trash" };
    }
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
