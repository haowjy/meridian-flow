/** Work-scoped authority over the account command owner; its notices live in the owner (`DraftNotices`). */

import { t } from "@lingui/core/macro";
import { parseDraftItemKey } from "@meridian/contracts";
import type { ThreadDraftListItem, ThreadDraftListResponse } from "@meridian/contracts/branches";
import { type Work, workLifecycleState } from "@meridian/contracts/works";
import { useQueryClient } from "@tanstack/react-query";
import type { Editor } from "@tiptap/core";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import { unapplyCommand, undoDiscard } from "@/client/api/branches-api";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import {
  cachedOwnerDrafts,
  ownerDraftsQueryOptions,
  patchOwnerDrafts,
  relistedOwnerDraft,
  useOwnerDraftsFrozen,
} from "@/client/query/useOwnerDrafts";
import { documentBasename } from "@/client/query/work-branch-files";
import { editorHistory } from "@/core/editor/editor-history";
import { pushUndoStep, shownSourceOf } from "@/core/project-tree/tree-undo";
import {
  useDraftCommandOwner,
  useOptionalContextRemovalCoordinator,
  useOptionalDraftOnlyPresentations,
  useOptionalTreeLists,
} from "@/features/project/context/account-feature-context";
import { draftTreeVersion } from "@/features/project/tree-version";
import { isDeletedFromManuscript } from "./deleted-drafts";
import { type CommandOutcome, folderKey } from "./draft-command-owner";
import type { DiscardPart, DiscardUndo, NoticeSurface } from "./draft-notices";
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
  // An archived or deleted Work's drafts show, and take no command until it is back.
  const locked = !ownerKey || !work || workLifecycleState(work) !== "active";
  // The server's word: a lineage with every chat in Trash. Its draft rooms drop the writer's
  // text, so a whole Discard goes to the server, which allows it, and nothing else is sent.
  const frozen = useOwnerDraftsFrozen(projectId, ownerKey);
  const notices = owner.notices;
  const removal = useOptionalContextRemovalCoordinator();
  const treeLists = useOptionalTreeLists();
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
     * The one Discard rule: whether this Discard runs here as a local text Discard, whose Undo
     * the room holds. That is a change the writer sees in a read frame, or a whole text draft
     * (not a created document or a picture, with no move or delete) whose room is read now. Any
     * other Discard goes to the server, whose Undo is its own command.
     */
    const discardsLocally = (draft: DraftReviewSelection, target: ChangeTarget) => {
      if (locked || frozen || target.kind === "tree") return false;
      if (target.kind === "groups") return !target.tree;
      const item = row(draft);
      return !item?.wholeItem && !item?.tree && owner.canDiscardLocally(draft.itemKey);
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
    ) => {
      if (surface === "band" || done.length === 0) return;
      const held = notices.appliedFacts(ownerKey);
      const picked = new Set(done.flatMap(({ item }) => (item ? [item.itemKey] : [])));
      // Every member of one command answers with the command's whole list.
      const facts = [
        ...new Map(
          done.flatMap(({ outcome }) => outcome.applied ?? []).map((fact) => [fact.itemKey, fact]),
        ).values(),
      ];
      const restored = [
        ...(held?.restored ?? []),
        ...done.flatMap(({ item, outcome }) => {
          const title = titleOf(item);
          return outcome.restored && title ? [title] : [];
        }),
      ];
      // A document the Apply put somewhere new says where: a new one would look lost otherwise.
      const moved = facts.filter(
        (fact) =>
          picked.has(fact.itemKey) &&
          fact.transition?.to &&
          folderOf(fact.transition.from) !== folderOf(fact.transition.to),
      );
      const landed = [
        ...(held?.landed ?? []),
        ...moved.flatMap(({ itemKey, transition }) => {
          const documentId = parseDraftItemKey(itemKey)?.documentId;
          return documentId && transition?.to ? [{ documentId, uri: transition.to }] : [];
        }),
      ];
      const renamed = [
        ...(held?.renamed ?? []),
        ...facts.flatMap(({ renamed: path, itemKey }) => {
          // A new place names the document under the name it landed with.
          if (!path || moved.some((landing) => landing.itemKey === itemKey)) return [];
          const name = documentBasename(path);
          return name ? [name] : [];
        }),
      ];
      const alsoApplied = [
        ...(held?.alsoApplied ?? []),
        ...facts.flatMap((fact) => {
          if (picked.has(fact.itemKey) || !fact.transition) return [];
          const from = documentBasename(fact.transition.from);
          const to = documentBasename(fact.transition.to);
          return from && to ? [`${from} → ${to}`] : [];
        }),
      ];
      if (restored.length || renamed.length || alsoApplied.length || landed.length)
        notices.showApplied({
          projectId,
          ownerKey,
          surface: noticeSurface(draft),
          restored,
          renamed,
          alsoApplied,
          landed,
        });
    };
    /**
     * An Apply goes on the sidebar's Undo stack as one step (design §5): its Undo is the server's
     * Un-Apply of the whole command, which answers `refused` once anything changed since. A
     * band's Apply has its editor's Undo instead.
     */
    const rememberApply = (
      commandId: string,
      branchId: string,
      nodes: readonly string[],
      name: string,
    ) => {
      if (surface === "band" || !treeLists) return;
      const handle = treeLists.acquire({ kind: "project", projectId });
      const session = handle.session;
      // The Work's tree shows every node the Apply took, before it and after.
      const { view, pendingText } = draftTreeVersion(
        branchId,
        cachedOwnerDrafts(queryClient, projectId, ownerKey) ?? null,
        work ? workLifecycleState(work) : "active",
      );
      const shown = session.replay(view, pendingText);
      const documentIds = nodes.filter((node) => shown.nodes.get(node)?.kind !== "folder");
      // A resend after a lost answer names the same Un-Apply: the server answers it once.
      const unapplyId = crypto.randomUUID();
      pushUndoStep(session, {
        kind: "apply",
        sources: [...new Set(nodes.flatMap((node) => shownSourceOf(shown, node) ?? []))],
        name,
        unapply: async () => {
          try {
            const answer = await unapplyCommand(projectId, branchId, {
              commandId: unapplyId,
              applyCommandId: commandId,
            });
            if (answer.status === "conflict") return { answer: "failed" };
            refresh(documentIds);
            if (answer.status !== "unapplied") return { answer: "skipped" };
            // What the Apply's notice said is no longer so.
            if (notices.appliedFacts(ownerKey)) endNotice();
            for (const documentId of documentIds) owner.forgetApplyFacts(projectId, documentId);
            return { answer: "unapplied", textLeft: answer.skippedGroupIds.length };
          } catch {
            return { answer: "failed" };
          }
        },
      });
      handle.release();
    };
    const applyOne = (draft: DraftReviewSelection, target: ChangeTarget): CommandStart => {
      endNotice();
      if (locked) return blocked();
      const item = row(draft);
      const tree = target.kind === "tree" || target.kind === "draft" || target.tree;
      const started = owner.apply(
        ref(draft),
        target,
        isDeletedFromManuscript(item),
        (tree && item?.tree) || undefined,
        editorHistoryOf(reviewEditor?.(draft)),
      );
      if (!started) return blocked();
      void started.outcome.then((outcome) => {
        if (outcome.kind === "done" && tree && item?.tree) dropTreeLine(item);
        if (outcome.kind === "done") {
          applied(draft, [{ item, outcome }]);
          if (outcome.commandId && item)
            rememberApply(
              outcome.commandId,
              item.branchId,
              [draft.documentId],
              titleOf(item) ?? t`Untitled document`,
            );
        }
        if (outcome.kind === "needs-restore" || !owner.state(draft.itemKey).pending)
          refresh([draft.documentId]);
      });
      return started;
    };
    /**
     * Several drafts and folders as one Apply command, one step of Undo: Apply all, a folder's ✓.
     * `restore`: the documents its confirmation named, which it brings back from a delete; it
     * brings back no other. `folders`: the folder changes it takes, with what is listed under
     * them. Resolves to each item's outcome.
     */
    const applyMany = (
      items: readonly { draft: DraftReviewSelection; target: ChangeTarget }[],
      restore: ReadonlySet<string> = new Set(),
      folders: readonly string[] = [],
      name?: string,
    ): Promise<CommandOutcome[]> => {
      endNotice();
      const listed = queryClient.getQueryData<ThreadDraftListResponse>(
        projectQueryKeys.ownerDrafts(projectId, ownerKey),
      );
      const branchId = listed?.branchId;
      if (locked || !branchId)
        return Promise.resolve(items.map(() => ({ kind: "blocked" as const })));
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
            return outcome.kind === "needs-restore" &&
              member &&
              isDeletedFromManuscript(row(member.draft))
              ? { kind: "needs-restore", deleted: true }
              : outcome;
          });
        },
      );
      void Promise.all([outcomes, Promise.all(started.outcomes), started.answer]).then(
        ([settled, _all, answer]) => {
          if (first)
            applied(
              first.draft,
              settled.flatMap((outcome, index) =>
                outcome.kind === "done" ? [{ item: members[index]?.item, outcome }] : [],
              ),
            );
          if (folders.length > 0) refresh([]);
          if (answer?.status !== "applied") return;
          const taken = [...members.map(({ draft }) => draft.documentId), ...folders];
          const only = members.length === 1 && folders.length === 0 ? titleOf(first?.item) : null;
          const count = taken.length;
          rememberApply(answer.commandId, branchId, taken, name ?? only ?? t`${count} changes`);
        },
      );
      return outcomes;
    };
    /** The Undo of a Discard the server ran: its Undo command, which copies back both halves. */
    const serverUndo = (
      branchId: string,
      discardCommandId: string,
      documentIds: readonly string[],
    ): DiscardUndo => ({
      undo: async () => {
        const settled = { landed: Promise.resolve() };
        try {
          const answer = await undoDiscard(projectId, branchId, {
            commandId: crypto.randomUUID(),
            discardCommandId,
          });
          refresh(documentIds);
          if (answer.status === "restored")
            return { ...settled, answer: "ok", leftOut: answer.leftOut };
          if (
            answer.status === "refused" &&
            (answer.reason === "already_restored" || answer.reason === "nothing_to_restore")
          )
            return { ...settled, answer: "gone" };
          return { ...settled, answer: "failed" };
        } catch {
          return { ...settled, answer: "failed" };
        }
      },
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
     * One Discard and its share of the notice's Undo: a room's text, the server's command (a
     * whole draft not read here, a move or delete), or both. A frozen owner's Discard has no
     * Undo: its Undo command would be refused, so it asked first.
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
      const share = (handle: DiscardUndo, outcome: Promise<CommandOutcome>, ownText: boolean) => {
        if (frozen) return null;
        void outcome.then((answer) => {
          if (answer.kind !== "done" && !ownText) notices.partEnded(handle);
        });
        return { documentId: draft.documentId, name, scope, handle };
      };
      // A whole draft that can't be discarded here ends on the server, everything it holds.
      if (target.kind === "draft" && !discardsLocally(draft, target)) {
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
          part: share(serverUndo(item.branchId, commandId, [draft.documentId]), outcome, false),
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
          part: share(handle, outcome, discarded.handle !== null),
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
    /**
     * A Discard of a selection as one server command over exactly those items: whole drafts
     * (their text and tree changes) and folder changes, with what stands on them. A folder group's
     * × and a folder changed alone send it; only Discard all (`all`) takes the whole branch. Its
     * notice's Undo is the server's Undo of that Discard, which brings both halves back. `name`:
     * the folder the selection is, for the notice.
     */
    const discardSelection = (
      input:
        | { all: true; drafts: readonly DraftReviewSelection[]; name: null }
        | {
            all?: false;
            drafts: readonly DraftReviewSelection[];
            folders: readonly string[];
            name: string | null;
          },
    ): Promise<CommandOutcome> => {
      endNotice();
      const listed = queryClient.getQueryData<ThreadDraftListResponse>(
        projectQueryKeys.ownerDrafts(projectId, ownerKey),
      );
      const branchId = listed?.branchId;
      const folders = input.all ? [] : input.folders;
      if (locked || !branchId || (input.drafts.length === 0 && folders.length === 0))
        return Promise.resolve({ kind: "blocked" });
      const commandId = crypto.randomUUID();
      const documentIds = input.drafts.map((draft) => draft.documentId);
      const refs = input.drafts.map(ref);
      const outcome = owner
        .discardBranch({
          projectId,
          branchId,
          commandId,
          selection: input.all
            ? { all: true, refs }
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
                  ...folders.map((node) => ({
                    ref: {
                      projectId,
                      ownerKey,
                      documentId: node,
                      itemKey: folderKey(branchId, node),
                    },
                    ends: "item" as const,
                  })),
                ],
              },
        })
        .then((answer) => {
          if (answer.kind === "done" && !input.all) {
            const ended = new Set(input.drafts.map((draft) => draft.itemKey));
            patchOwnerDrafts(queryClient, projectId, ownerKey, (rows) =>
              rows.filter((listed) => !ended.has(listed.itemKey)),
            );
          }
          refresh(documentIds);
          return answer;
        });
      if (!frozen) {
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
              ...(input.name
                ? { name: input.name, scope: "folder" as const }
                : {
                    name: titleOf(first ? row(first) : undefined) ?? t`Untitled document`,
                    scope: "draft" as const,
                    count,
                  }),
              handle,
            },
          ],
        });
      }
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
      ownerKey,
      threadId,
      owner,
      /**
       * Whether this Discard asks first: a frozen owner's, the one Discard with no Undo. Every
       * other Discard's notice takes it back.
       */
      discardAsks: (_draft: DraftReviewSelection, _target?: ChangeTarget) => frozen,
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
      discardAll: (drafts: readonly DraftReviewSelection[]) =>
        discardSelection({ all: true, drafts, name: null }),
    };
  }, [
    owner,
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

/** The folder part of a document's address; null for none. */
const folderOf = (uri: string | null | undefined) =>
  uri ? uri.slice(0, uri.lastIndexOf("/") + 1) : null;
