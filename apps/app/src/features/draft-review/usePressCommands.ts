/**
 * The commands of a Work's review surfaces (the Changes list, a chat's strip, a document's
 * band): every Apply and Discard of a document, a folder, a selection or the whole Work is one
 * press (`press-commands.ts`), run by the server over both halves, with one Undo.
 *
 * The rows a press takes leave the list as it is sent; a press that fails puts them back with a
 * pill. Its notice is the draft notice: a Discard's rows struck with Undo, an Apply's rows with
 * Undo. Each press is one step on the sidebar's Undo stack too (`PressStep`) and, as it is made,
 * on the Ctrl+Z of each editor open on its documents (`EditorPressStep`); every Undo of it, on
 * its notice, the sidebar or an editor, is the press's one Undo and takes the others' steps away.
 */
import { t } from "@lingui/core/macro";
import type { CommandDriver } from "@meridian/command-driver";
import {
  type DocumentId,
  type DraftId,
  parseDraftItemKey,
  type TurnId,
  type WorkId,
} from "@meridian/contracts";
import type {
  DraftItem,
  DraftItemsResponse,
  PressAction,
  PressResult,
  PressScope,
  PressUndoResult,
} from "@meridian/contracts/drafts";
import type { Thread, TreeListRef } from "@meridian/contracts/protocol";
import type { Work } from "@meridian/contracts/works";
import { LIVE } from "@meridian/project-tree";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useMemo } from "react";
import { useCommandDriver } from "@/client/commands/driver-context";
import { pressLaneKey, submitPress, submitPressUndo } from "@/client/query/press-commands";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { threadQueryKeys } from "@/client/query/thread-query-keys";
import { cachedOwnerDrafts, patchOwnerDrafts } from "@/client/query/useOwnerDrafts";
import { documentBasename, projectWorkDraftFiles } from "@/client/query/work-draft-files";
import { notifyFailure } from "@/components/app/failure-toast";
import {
  dropUndoStep,
  type PressStep,
  pushUndoStep,
  shownSourceOf,
} from "@/core/project-tree/tree-undo";
import type { TreeListSession } from "@/core/tree-list/tree-list-session";
import {
  useDraftCommandOwner,
  useOptionalContextRemovalCoordinator,
  useOptionalLiveDocumentSessionRegistry,
  useOptionalPresentedDocuments,
  useOptionalTreeLists,
} from "@/features/project/context/account-feature-context";
import { useItemLauncher } from "@/features/project/review-launch";
import { type CommandOutcome, folderKey } from "./draft-command-owner";
import type { DiscardPart, NoticeSurface } from "./draft-notices";
import {
  type EditorHistory,
  EditorPressStep,
  PressEntries,
  type PressPort,
  type Seat,
} from "./press-history";
import { stayedLabel } from "./stayed-words";
import type { DraftItemRef } from "./useDraftReviewController";

type Verdict = "apply" | "discard";
type Scope = PressAction["scope"];
type TurnScope = Extract<Scope, { kind: "turn" }>;
/**
 * Each tree list whose rows showed the press's nodes in the Work's tree as it was sent, with the
 * sources they showed in: the sidebar stacks its Undo step goes on.
 */
type Placement = readonly { list: TreeListRef; sources: readonly string[] }[];
/**
 * `took`: the documents and folders the press changed, in their text or their place in the tree.
 * `landed`: when its answer came, before the lists were read again.
 */
type Pressed = {
  commandId: string;
  lane: string;
  took: readonly string[];
  placement: Placement;
  landed: number;
};
/**
 * `failed`: the press reached the server, which didn't take it. `told`: it was never sent, and
 * `submitCommand` has told the writer already.
 */
type Unpressed = "failed" | "told";
/**
 * What a press does, and the documents it expects to take whole (`null`: every row listed). A
 * change press or a Restore before takes part of a document: its row stays listed.
 */
type PressTarget = { action: PressAction; documents: readonly string[] | null; whole: boolean };

export type CommandStart = { sent: boolean; outcome: Promise<CommandOutcome> };
export type WorkDraftCommands = ReturnType<typeof usePressCommands>;

export function usePressCommands({
  projectId,
  work,
  drafts: draftList,
  threadId = null,
  surface,
}: {
  projectId: string;
  /** The Work the drafts belong to, if any: the chat strip counts what its Changes list holds. */
  work: Work | null;
  /**
   * The drafts the commands act on: one (a chat's, a page's), or every draft of `work` (the
   * Changes tab), whose "all" is the Work's press. Empty acts on none.
   */
  drafts: readonly string[];
  threadId?: string | null;
  /** Where this surface's notices show: the Changes list, a chat's strip, or a document's band. */
  surface: NoticeSurface["kind"];
}) {
  // A new array each render would remake every command: the list's ids are what matter.
  const draftsKey = draftList.join(",");
  const owner = useDraftCommandOwner();
  const driver = useCommandDriver();
  const treeLists = useOptionalTreeLists();
  const removal = useOptionalContextRemovalCoordinator();
  const presented = useOptionalPresentedDocuments();
  const registry = useOptionalLiveDocumentSessionRegistry();
  const { openDraftFile } = useItemLauncher();
  const queryClient = useQueryClient();
  const locked = !draftsKey || !driver;
  return useMemo(() => {
    const { notices } = owner;
    const drafts = draftsKey ? draftsKey.split(",") : [];
    const draftId = drafts[0] ?? "";
    const workWide = drafts.length > 1 && work !== null;
    const workKey = work ? `work:${work.id}` : "";
    /** Whose notice a press shows: its draft's, or the Work's for a press of every draft. */
    const noticeOf = (scope: Scope) =>
      scope.kind === "work"
        ? workKey
        : scope.kind === "draft" || scope.kind === "turn"
          ? scope.draft
          : (parseDraftItemKey(scope.item)?.draftId ?? draftId);
    /** The drafts a press acts on: a change's or a document's own, a turn's one, else all of the surface's. */
    const scopeDrafts = (scope: Scope): readonly string[] =>
      scope.kind === "work"
        ? drafts
        : scope.kind === "draft" || scope.kind === "turn"
          ? [scope.draft]
          : [parseDraftItemKey(scope.item)?.draftId ?? draftId];
    /** The rows listed now of the surface's drafts and, for a press, of its scope's. */
    const rows = (scope?: Scope) =>
      [...new Set([...drafts, ...(scope ? scopeDrafts(scope) : [])])].flatMap(
        (draft) => cachedOwnerDrafts(queryClient, projectId, draft) ?? [],
      );
    const nameOf = (node: string) => {
      const row = rows().find((item) => item.documentId === node);
      return row?.documentName ?? documentBasename(row?.contextLocation?.path) ?? "";
    };
    const noticeSurface = (documentId: string | null): NoticeSurface =>
      surface === "band" && documentId
        ? { kind: "band", documentId }
        : surface === "strip"
          ? { kind: "strip", threadId }
          : { kind: "changes" };
    /**
     * Reads the lists again; a row a press took or gave back shows once this lands. A Restore
     * before reads its turn's card again too, dropping a read already out, so any card read that
     * lands after this says whether the press is in force (`RestoreEntry.since`).
     */
    const refresh = async (scope: Scope) => {
      if (scope.kind === "turn" && threadId)
        void queryClient.refetchQueries(
          { queryKey: threadQueryKeys.liveLineage(threadId, scope.turn), exact: true },
          { cancelRefetch: true },
        );
      await Promise.all(
        [...new Set([...drafts, ...scopeDrafts(scope)])].map((draft) =>
          queryClient.refetchQueries(
            { queryKey: projectQueryKeys.drafts(projectId, draft) },
            { cancelRefetch: false },
          ),
        ),
      );
    };
    const blocked = (): CommandStart => ({
      sent: false,
      outcome: Promise.resolve({ kind: "blocked" }),
    });

    /** A press's Undo: the server takes back what that press did, and nothing else. */
    const unpress = async (
      commandId: string,
      lane: string,
      scope: Scope,
    ): Promise<PressUndoResult | Unpressed> => {
      if (!driver) return "failed";
      const record = await submitPressUndo(driver, lane, {
        projectId,
        pressCommandId: commandId,
      });
      if (!record) return "told";
      const settled = await driver.whenSettled(record.id);
      await refresh(scope);
      return settled?.state === "done" && settled.outcome?.status === "done"
        ? (settled.outcome.result as PressUndoResult)
        : "failed";
    };

    /** A chat's title by its ref (`c12`), from the project's chats as this tab last read them. */
    const chatTitle = (ref: string) =>
      queryClient
        .getQueryData<Thread[]>(projectQueryKeys.threads(projectId))
        ?.find((thread) => thread.ref === ref)?.title ?? null;

    /**
     * What an Undo left in place (`PressUndoResult.stayed`): marked in each editor showing its
     * document, and said on the surface's rows until the next press.
     */
    const showStayed = (
      stayed: PressUndoResult["stayed"],
      scope: Scope,
      names: ReadonlyMap<string, string>,
      noticeKey: string,
      where: NoticeSurface,
    ) => {
      if (stayed.length === 0) return;
      const kept = stayed.map((change) => ({
        documentId: change.documentId,
        change: change.change,
        name: names.get(change.documentId) ?? nameOf(change.documentId),
        label: stayedLabel(change.by, chatTitle),
      }));
      for (const documentId of new Set(kept.map((fact) => fact.documentId))) {
        const labels = new Map(
          kept.flatMap((fact) =>
            fact.documentId === documentId ? [[fact.change, fact.label]] : [],
          ),
        );
        for (const history of editorsOf([documentId], scope)) history.showStayed(labels);
      }
      notices.showStayed({
        projectId,
        draftId: noticeKey,
        surface: where,
        kept: kept.map(({ documentId, name, label }) => ({ documentId, name, label })),
      });
    };

    /**
     * Where the nodes show in the Work's tree now, in the project's list and the account's: its
     * view shows both what Live holds and what the Work made. None found, the project's list
     * holds the step under every source.
     */
    const placementOf = (nodes: readonly string[]): Placement => {
      if (!treeLists) return [];
      const project: TreeListRef = { kind: "project", projectId };
      const placement = [project, treeLists.account].flatMap((list) => {
        const handle = treeLists.acquire(list);
        const sources = new Set<string>();
        for (const draft of drafts) {
          const listed = queryClient.getQueryData<DraftItemsResponse>(
            projectQueryKeys.drafts(projectId, draft),
          );
          const shown = handle.session.replay(listed ? { draft } : LIVE);
          for (const node of nodes)
            for (const source of shownSourceOf(shown, node) ?? []) sources.add(source);
        }
        handle.release();
        return sources.size ? [{ list, sources: [...sources] }] : [];
      });
      return placement.length ? placement : [{ list: project, sources: [] }];
    };

    /** A folder's name as the Work's tree shows it, in the project's list or the account's. */
    const folderName = (node: string): string => {
      if (!treeLists) return "";
      for (const list of [{ kind: "project", projectId } as TreeListRef, treeLists.account])
        for (const draft of drafts) {
          const handle = treeLists.acquire(list);
          const name = handle.session.replay({ draft }).nodes.get(node)?.name;
          handle.release();
          if (name) return name;
        }
      return "";
    };

    /**
     * A press's step on the Undo stack of each list in its placement, one `undo` for all of them.
     * The stacks belong to the lists' sessions, whoever holds them, as a gesture's steps do.
     */
    const seatOf = (nodes: readonly string[], undo: () => Promise<boolean>) => {
      let placement: Placement = [];
      let seated: { session: TreeListSession; step: PressStep }[] = [];
      const seat: Seat = {
        push: () => {
          if (seated.length || !treeLists) return;
          seated = placement.map(({ list, sources }) => {
            const handle = treeLists.acquire(list);
            const step: PressStep = { kind: "press", sources, nodes, undo };
            pushUndoStep(handle.session, step);
            handle.release();
            return { session: handle.session, step };
          });
        },
        drop: () => {
          for (const { session, step } of seated) dropUndoStep(session, step);
          seated = [];
        },
      };
      /** The press in force landed here: a Redo is a new press, which may have moved. */
      const place = (where: Placement) => {
        placement = where;
      };
      return { seat, place };
    };

    /**
     * A press on the sidebar's stack (`PressEntries`): the sidebar's Ctrl+Z, or its notice's Undo,
     * takes back the press once. `dropped`: it was taken back, and its notice goes with it.
     */
    const remember = (
      scope: Scope,
      verdict: PressAction["verdict"],
      pressed: Pressed,
      editor: EditorPressStep,
      shown: { noticeKey: string; where: NoticeSurface; names: ReadonlyMap<string, string> },
      dropped: () => void,
    ): PressEntries => {
      const taken = pressed.took;
      // What the Undo that ends this press left in place, said once it has ended.
      let stayed: PressUndoResult["stayed"] = [];
      const { seat, place } = seatOf(taken, async () => (await entries.undo()).kind !== "failed");
      place(pressed.placement);
      const port: PressPort = {
        unpress: async (commandId) => {
          // An Apply's Undo takes a created document out of Live: main, read before, follows it to
          // the draft's plain page, where it is a draft's document again.
          const main = presented?.mainDocumentId(projectId);
          const answer = await unpress(commandId, pressed.lane, scope);
          if (typeof answer === "string")
            return answer === "told" ? { kind: "failed", told: true } : { kind: "failed" };
          stayed = answer.stayed;
          const created = rows().find((row) => row.documentId === main && row.isNew);
          if (verdict === "apply" && created && main && taken.includes(main))
            for (const file of projectWorkDraftFiles([created], null))
              openDraftFile(file, created.draftId);
          return { kind: "answered", unpressId: commandId, took: true };
        },
      };
      const entries: PressEntries = new PressEntries(
        pressed.commandId,
        port,
        {
          push: seat.push,
          drop: () => {
            seat.drop();
            editor.drop();
            dropped();
            showStayed(stayed, scope, shown.names, shown.noticeKey, shown.where);
          },
        },
        () => owner.presses.delete(entries),
        owner.changed,
      );
      owner.presses.add(entries);
      return entries;
    };

    /**
     * A Restore before in force: on the sidebar's stack and each editor's Ctrl+Z like any press,
     * and in the owner under its turn and draft, where the turn's card reads it and offers its
     * Undo. Taken back anywhere, it leaves the owner.
     */
    const restoreInForce = (
      scope: TurnScope,
      pressed: Pressed,
      editor: EditorPressStep,
      shown: { noticeKey: string; where: NoticeSurface; names: ReadonlyMap<string, string> },
    ): PressEntries => {
      const { turn, draft } = scope;
      const step: PressEntries = remember(scope, "restore", pressed, editor, shown, () => {
        const entry = owner.restore(turn, draft);
        if (entry?.kind === "in-force" && entry.press === step) owner.setRestore(turn, draft, null);
      });
      owner.setRestore(turn, draft, { kind: "in-force", press: step }, pressed.landed);
      return step;
    };

    /**
     * One press. Its rows and folders are in flight until the list is read again after it
     * (`DraftCommandOwner.hold`): they leave the list and the review, and nothing else can be
     * pressed on them. A row taken whole leaves the cached list too, so a read already out
     * can't bring it back; a press that fails gives it back with that read.
     */
    const press = async (
      target: PressTarget,
      live: CommandDriver,
    ): Promise<Pressed | Unpressed> => {
      const { verdict, scope } = target.action;
      const pressed = scopeDrafts(scope);
      const lists = pressed.flatMap((draft) => {
        const listed = queryClient.getQueryData<DraftItemsResponse>(
          projectQueryKeys.drafts(projectId, draft),
        );
        return listed ? [{ draft, listed }] : [];
      });
      const all = target.documents === null;
      const inScope = lists.flatMap(({ listed }) => listed.items);
      const nodes = target.documents ?? inScope.map((item) => item.documentId);
      const taken = inScope.filter((item) => all || nodes.includes(item.documentId));
      const gone = (item: DraftItem) => target.whole && (all || nodes.includes(item.documentId));
      // Discard all takes folders with only a tree change too: they have no row.
      const folders = all
        ? lists.flatMap(({ draft, listed }) =>
            listed.folders.map((folder) => ({ draft, id: folder.id })),
          )
        : [];
      const placement = placementOf([...nodes, ...folders.map((folder) => folder.id)]);
      const release = target.whole
        ? owner.hold(
            [
              ...taken.map((item) => item.itemKey),
              ...folders.map((folder) => folderKey(folder.draft, folder.id)),
            ],
            verdict === "apply",
          )
        : () => {};
      const liveVersions = taken.flatMap((item) =>
        item.liveVersion
          ? [{ documentId: item.documentId as DocumentId, version: item.liveVersion }]
          : [],
      );
      try {
        // A read already out answers from before the press: it must not bring the rows back.
        for (const draft of pressed) {
          await queryClient.cancelQueries({
            queryKey: projectQueryKeys.drafts(projectId, draft),
          });
          patchOwnerDrafts(queryClient, projectId, draft, (rowsNow) =>
            rowsNow.filter((item) => !gone(item)),
          );
        }
        // Each list's cut is the Work's tree as that list read it: the first is the press's.
        const saw = lists[0]?.listed.saw;
        const record = await submitPress(live, {
          projectId,
          ...target.action,
          ...(saw ? { saw } : {}),
          ...(verdict === "apply" && liveVersions.length ? { liveVersions } : {}),
        });
        if (!record) return "told";
        const settled = await live.whenSettled(record.id);
        const landed = Date.now();
        await refresh(scope);
        if (settled?.state !== "done" || settled.outcome?.status !== "done") return "failed";
        const result = settled.outcome.result as PressResult;
        return {
          commandId: record.sendId,
          lane: pressLaneKey(scope),
          took: [...new Set([...result.documents, ...result.items.map((item) => item.node)])],
          placement,
          landed,
        };
      } finally {
        release();
      }
    };

    /** What the press says of the nodes it was sent: the ones it changed nothing in are untaken. */
    const outcomeOf = (pressed: Pressed, nodes: readonly string[]): CommandOutcome => {
      const took = new Set(pressed.took);
      const untaken = nodes.filter((node) => !took.has(node));
      return took.size > 0
        ? { kind: "done", commandId: pressed.commandId, took: { untaken } }
        : { kind: "settled", took: { untaken } };
    };

    /**
     * The Ctrl+Z of each editor showing one of the documents now: in Live, or in a draft of the
     * press's scope that changes it. Two drafts of one Work can both hold a chapter. A turn names
     * its documents: its draft's fork of each, listed or not (an Apply took its rows).
     */
    const editorsOf = (documents: readonly string[], scope: Scope): EditorHistory[] => {
      const inScope = scopeDrafts(scope);
      const listed = rows(scope);
      return documents.flatMap((node) => {
        const documentId = node as DocumentId;
        const forks =
          scope.kind === "turn"
            ? [{ kind: "fork", draftId: scope.draft, documentId } as const]
            : listed.flatMap((item) =>
                item.documentId === node && inScope.includes(item.draftId)
                  ? [{ kind: "fork", draftId: item.draftId as DraftId, documentId } as const]
                  : [],
              );
        const rooms = [...forks, { kind: "live", documentId } as const];
        return rooms.flatMap((room) => {
          const history = registry?.openSession(room)?.history;
          return history?.open ? [history] : [];
        });
      });
    };

    /** `again`: a Redo in an editor presses again, under the step it already has. */
    const run = (
      target: PressTarget,
      input: { documentId: string | null; name?: string | null },
      again?: EditorPressStep,
    ): CommandStart => {
      const { verdict, scope } = target.action;
      // A turn's press names its draft; any other presses the surface's.
      const acting = scopeDrafts(scope);
      if (!driver || acting.length === 0 || !acting.every(Boolean)) return blocked();
      // The surface shows one notice: a new press ends the last, whichever draft it was on.
      for (const key of [...drafts, ...(workWide ? [workKey] : [])]) notices.end(key);
      const noticeKey = noticeOf(scope);
      const editor =
        again ??
        new EditorPressStep(
          editorsOf(target.documents ?? rows(scope).map((row) => row.documentId), scope),
          (step) => run(target, input, step),
        );
      let entries: PressEntries | null = null;
      // Named as listed now: the press takes the rows out of the list as it is sent.
      const names = new Map(rows(scope).map((row) => [row.documentId, nameOf(row.documentId)]));
      // A folder has no row: its name is the Work's tree's.
      const named = (node: string) => names.get(node) ?? folderName(node);
      // A document the Work created goes to Trash with its Discard: main leaves it first.
      if (verdict === "discard" && target.whole) {
        const taken = target.documents && new Set(target.documents);
        const created = rows().flatMap((row) =>
          row.isNew && (!taken || taken.has(row.documentId)) ? [row.documentId] : [],
        );
        if (created.length > 0) removal?.beginOwnRemoval(projectId, created);
      }
      const outcome = press(target, driver).then((pressed): CommandOutcome => {
        if (pressed === "failed")
          notifyFailure({
            key: `press:${noticeKey}`,
            title:
              verdict === "apply"
                ? t`Couldn't apply`
                : verdict === "restore"
                  ? t`Couldn't restore`
                  : t`Couldn't discard`,
            brief: true,
          });
        if (typeof pressed === "string") return { kind: "blocked" };
        const sent = target.documents ?? pressed.took;
        const answer = outcomeOf(pressed, sent);
        if (answer.kind !== "done") return answer;
        const changed = pressed.took;
        const where = noticeSurface(input.documentId);
        let step: PressEntries;
        const said = { noticeKey, where, names };
        if (scope.kind === "turn") {
          // The turn's card is its notice: it reads the press in force from the owner.
          step = restoreInForce(scope, pressed, editor, said);
        } else if (verdict === "apply") {
          step = remember(scope, verdict, pressed, editor, said, () => {
            if (notices.appliedFacts(noticeKey)?.facts.some((fact) => fact.step === step))
              notices.end(noticeKey);
          });
          notices.showApplied({
            projectId,
            draftId: noticeKey,
            surface: where,
            facts: changed.map((documentId) => ({
              documentId,
              kind: "applied" as const,
              name: named(documentId),
              step,
            })),
          });
        } else {
          let shown: number | null = null;
          step = remember(scope, verdict, pressed, editor, said, () => {
            // Taken back elsewhere (the sidebar, an editor): the notice's Undo goes with it.
            const notice = notices.get(noticeKey);
            if (notice?.id === shown && notice.kind === "discarded" && notice.status === "ready")
              notice.dismiss();
          });
          const [first] = changed;
          const part: DiscardPart = {
            documentId: input.documentId ?? first ?? "",
            name: input.name ?? named(input.documentId ?? first ?? ""),
            scope: "draft",
            ...(changed.length > 1 ? { count: changed.length } : {}),
            covers: changed,
            handle: {
              undo: async () => ({
                answer: (await step.undo()).kind === "failed" ? "failed" : "ok",
              }),
              end: () => {},
            },
          };
          shown = notices.showDiscard({
            projectId,
            draftId: noticeKey,
            surface: where,
            parts: [part],
          });
        }
        entries = step;
        return { ...answer, undo: () => step.undo() };
      });
      editor.pressing(outcome.then(() => entries));
      return { sent: true, outcome };
    };

    const documentTarget = (verdict: Verdict, item: DraftItemRef): PressTarget => ({
      action: { verdict, scope: { kind: "document", item: item.itemKey } },
      documents: [item.documentId],
      whole: true,
    });
    const draftScope: PressScope = workWide
      ? { kind: "work", work: work.id as WorkId }
      : { kind: "draft", draft: draftId as DraftId };
    const draftTarget = (verdict: Verdict): PressTarget => ({
      action: { verdict, scope: draftScope },
      documents: null,
      whole: true,
    });
    const startItem = (verdict: Verdict, item: DraftItemRef) =>
      run(documentTarget(verdict, item), { documentId: item.documentId });
    /** One change of a document, named by any of its members (`PressScope`'s `change`). */
    const startChange = (verdict: Verdict, item: DraftItemRef, change: string) =>
      run(
        {
          action: { verdict, scope: { kind: "change", item: item.itemKey, change } },
          documents: [item.documentId],
          whole: false,
        },
        { documentId: item.documentId },
      );
    /**
     * A Draft chat turn card's `Restore before` in one draft it wrote: `documents` are the ones
     * the turn wrote there, whose editors get the press's Ctrl+Z step. One at a time per turn and
     * draft: while one is out or in force, the card offers its Undo instead.
     */
    const restoreTurn = (turn: TurnId, draft: DraftId, documents: readonly string[]) => {
      if (owner.restore(turn, draft)) return;
      owner.setRestore(turn, draft, { kind: "sending" });
      const start = run(
        {
          action: { verdict: "restore", scope: { kind: "turn", turn, draft } },
          documents,
          whole: false,
        },
        { documentId: null },
      );
      // A press that changed nothing, or never landed, leaves nothing in force.
      void start.outcome.then(() => {
        if (owner.restore(turn, draft)?.kind === "sending") owner.setRestore(turn, draft, null);
      });
    };
    /** The Undo of the turn's Restore before in force in `draft`, the same as its Ctrl+Z. */
    const undoRestore = (turn: TurnId, draft: DraftId) => {
      const entry = owner.restore(turn, draft);
      if (entry?.kind === "in-force") void entry.press.undo();
    };
    /**
     * What a read of the turn's card (`TurnReceiptChip.restored`, read at `readAt`) says is in
     * force in `draft`: `named`, a press id, or null for none; undefined where the server doesn't
     * say. A press this tab doesn't hold (another tab's, or one from before a reload) is taken on
     * with the card's Undo alone; one the read says ended elsewhere ends here, its Ctrl+Z and
     * sidebar steps with it. A read from before the entry last changed here is out of date.
     */
    const syncRestore = (
      turn: TurnId,
      draft: DraftId,
      named: string | null | undefined,
      readAt: number,
    ) => {
      if (named === undefined || readAt < owner.restoreChangedAt(turn, draft)) return;
      const entry = owner.restore(turn, draft);
      if (entry?.kind === "sending" || (entry?.press.id ?? null) === named) return;
      entry?.press.end();
      if (named === null) return;
      const scope = { kind: "turn", turn, draft } as const;
      restoreInForce(
        scope,
        { commandId: named, lane: pressLaneKey(scope), took: [], placement: [], landed: readAt },
        new EditorPressStep([], () => {}),
        { noticeKey: draft, where: noticeSurface(null), names: new Map() },
      );
    };
    /** The draft's files: one press on the whole draft; a single file presses that document. */
    const many = (verdict: Verdict, items: readonly DraftItemRef[]) => {
      const [only] = items;
      const target =
        items.length === 1 && only ? documentTarget(verdict, only) : draftTarget(verdict);
      return run(target, { documentId: only?.documentId ?? null }).outcome.then((outcome) =>
        items.map(() => outcome),
      );
    };
    const discardSelection = (input: {
      all?: boolean;
      items: readonly DraftItemRef[];
      name: string | null;
    }): Promise<CommandOutcome> => {
      const [only] = input.items;
      const target =
        !input.all && input.items.length === 1 && only
          ? documentTarget("discard", only)
          : draftTarget("discard");
      return run(target, { documentId: only?.documentId ?? null, name: input.name }).outcome;
    };
    return {
      projectId,
      work,
      /** The surface's draft: its one, or with several the first. */
      draftId,
      drafts,
      /** Whose notices the surface shows (`useDraftNotice`): each draft's, and with several the Work's. */
      noticeKeys: workWide ? [workKey, ...drafts] : drafts,
      threadId,
      owner,
      dispositionLocked: locked,
      startItem: (verdict: Verdict, item: DraftItemRef) => startItem(verdict, item),
      startChange,
      restoreTurn,
      undoRestore,
      syncRestore,
      apply: (documentId: string, itemKey: string) =>
        startItem("apply", { documentId, itemKey }).outcome,
      discard: (documentId: string, itemKey: string) =>
        startItem("discard", { documentId, itemKey }).outcome,
      applyMany: (items: readonly DraftItemRef[]) => many("apply", items),
      discardMany: (items: readonly DraftItemRef[]) => many("discard", items),
      discardSelection,
      discardAll: (items: readonly DraftItemRef[], name: string | null) =>
        discardSelection({ all: true, items, name }),
    };
  }, [
    owner,
    driver,
    registry,
    treeLists,
    removal,
    presented,
    openDraftFile,
    queryClient,
    locked,
    projectId,
    work,
    draftsKey,
    threadId,
    surface,
  ]);
}

const WorkDraftCommandsContext = createContext<WorkDraftCommands | null>(null);
/** One surface's commands for the surfaces under it (`useBoundWorkDraftCommands`). */
export const WorkDraftCommandsBoundary = WorkDraftCommandsContext.Provider;
export function useBoundWorkDraftCommands(): WorkDraftCommands {
  const commands = useContext(WorkDraftCommandsContext);
  if (!commands) throw new Error("Work commands require a WorkDraftCommandsBoundary");
  return commands;
}
