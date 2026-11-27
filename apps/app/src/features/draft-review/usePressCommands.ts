import type { CommandDriver } from "@meridian/command-driver";
import {
  type DocumentId,
  type DraftId,
  parseDraftItemKey,
  type TurnId,
  type WorkId,
} from "@meridian/contracts";
import type {
  DraftItemsResponse,
  PressAction,
  PressResult,
  PressScope,
  PressUndoResult,
} from "@meridian/contracts/drafts";
import type { TreeListRef } from "@meridian/contracts/protocol";
import type { Work } from "@meridian/contracts/works";
import { LIVE } from "@meridian/project-tree";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useMemo } from "react";
import { useCommandDriver } from "@/client/commands/driver-context";
import { pressDrafts, submitPress, submitPressUndo } from "@/client/query/press-commands";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { threadQueryKeys } from "@/client/query/thread-query-keys";
import { cachedOwnerDrafts } from "@/client/query/useOwnerDrafts";
import { documentBasename, projectWorkDraftFiles } from "@/client/query/work-draft-files";
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
import type { CommandOutcome, HeldNoticeRows } from "./draft-command-owner";
import { type NoticeSurface, workNoticeKey } from "./draft-notices";
import {
  type EditorHistory,
  EditorPressStep,
  PressEntry,
  type Seat,
  type Undone,
} from "./press-history";

type Verdict = "apply" | "discard";
type Scope = PressAction["scope"];
type TurnScope = Extract<Scope, { kind: "turn" }>;
type Placement = readonly { list: TreeListRef; sources: readonly string[] }[];
type Pressed = {
  commandId: string;
  drafts: readonly string[];
  took: readonly string[];
  placement: Placement;
  landed: number;
};
type Unpressed = "failed" | "told";
type PressTarget = { action: PressAction; documents: readonly string[] | null; whole: boolean };

export type DraftItemRef = { documentId: string; itemKey: string };
export type WorkDraftCommands = ReturnType<typeof usePressCommands>;

export function usePressCommands({
  projectId,
  work,
  drafts: draftList,
  threadId = null,
  surface,
}: {
  projectId: string;
  work: Work | null;
  drafts: readonly string[];
  threadId?: string | null;
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
    const workKey = work ? workNoticeKey(work.id) : "";
    const noticeOf = (scope: Scope) =>
      scope.kind === "work"
        ? workKey
        : scope.kind === "draft" || scope.kind === "turn"
          ? scope.draft
          : (parseDraftItemKey(scope.item)?.draftId ?? draftId);
    const rows = (scope?: Scope) =>
      [...new Set([...drafts, ...(scope ? pressDrafts(scope) : [])])].flatMap(
        (draft) => cachedOwnerDrafts(queryClient, projectId, draft) ?? [],
      );
    const nameOf = (node: string) => {
      const row = rows().find((item) => item.documentId === node);
      return row?.documentName ?? documentBasename(row?.contextLocation?.path) ?? "";
    };
    const noticeSurface = (documentId: string | null, draft: string): NoticeSurface =>
      surface === "page" && documentId
        ? { kind: "page", documentId, draftId: draft }
        : surface === "strip"
          ? { kind: "strip", threadId }
          : { kind: "changes" };
    /**
     * Reads the lists again; a row a press took or gave back shows once this lands. An Undo
     * turn reads its turn's card again too, dropping a read already out, so any card read that
     * lands after this says whether the press is in force (`RestoreEntry.since`).
     */
    const refresh = async (scope: Scope) => {
      if (scope.kind === "turn" && threadId)
        void queryClient.refetchQueries(
          { queryKey: threadQueryKeys.liveLineage(threadId, scope.turn), exact: true },
          { cancelRefetch: true },
        );
      await Promise.all(
        [...new Set([...drafts, ...pressDrafts(scope)])].map((draft) =>
          queryClient.refetchQueries(
            { queryKey: projectQueryKeys.drafts(projectId, draft) },
            { cancelRefetch: false },
          ),
        ),
      );
    };
    const unpress = async (
      commandId: string,
      pressedDrafts: readonly string[],
      scope: Scope,
    ): Promise<PressUndoResult | Unpressed> => {
      if (!driver) return "failed";
      const record = await submitPressUndo(driver, pressedDrafts, {
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
      const place = (where: Placement) => {
        placement = where;
      };
      return { seat, place };
    };

    const remember = (
      scope: Scope,
      verdict: PressAction["verdict"],
      pressed: Pressed,
      editor: EditorPressStep,
      dropped: () => void,
    ): PressEntry => {
      const taken = pressed.took;
      const { seat, place } = seatOf(taken, async () => (await entry.undo()).ok);
      place(pressed.placement);
      const undo = async (): Promise<Undone> => {
        // An Apply's Undo takes a created document out of Live: main, read before, follows it to
        // the draft's plain page, where it is a draft's document again.
        const main = presented?.mainDocumentId(projectId);
        const answer = await unpress(pressed.commandId, pressed.drafts, scope);
        if (typeof answer === "string")
          return answer === "told" ? { ok: false, told: true } : { ok: false };
        const created = rows().find((row) => row.documentId === main && row.isNew);
        if (verdict === "apply" && created && main && taken.includes(main))
          for (const file of projectWorkDraftFiles([created], null))
            openDraftFile(file, created.draftId);
        return { ok: true };
      };
      const entry: PressEntry = new PressEntry(
        pressed.commandId,
        undo,
        {
          push: seat.push,
          drop: () => {
            seat.drop();
            editor.drop();
            dropped();
          },
        },
        () => owner.presses.delete(entry),
        owner.changed,
      );
      owner.presses.add(entry);
      return entry;
    };

    const restoreInForce = (
      scope: TurnScope,
      pressed: Pressed,
      editor: EditorPressStep,
    ): PressEntry => {
      const { turn, draft } = scope;
      const step: PressEntry = remember(scope, "restore", pressed, editor, () => {
        const entry = owner.restore(turn, draft);
        if (entry?.kind === "in-force" && entry.press === step) owner.setRestore(turn, draft, null);
      });
      owner.setRestore(turn, draft, { kind: "in-force", press: step }, pressed.landed);
      return step;
    };

    /**
     * One press. Its rows and folders are in flight while the journal holds it, until a list read
     * after its answer (`DraftCommandOwner.followPresses`): they leave the list and the review, and
     * nothing else can be pressed on them. Every list read subtracts the journal hold, including a
     * read already out; a press that fails releases the hold and gives the rows back.
     */
    const press = async (
      target: PressTarget,
      live: CommandDriver,
    ): Promise<Pressed | Unpressed> => {
      const { verdict, scope } = target.action;
      const pressed = pressDrafts(scope);
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
      // Discard all takes folders with only a tree change too: they have no row.
      const folders = all
        ? lists.flatMap(({ draft, listed }) =>
            listed.folders.map((folder) => ({ draft, id: folder.id })),
          )
        : [];
      const placement = placementOf([...nodes, ...folders.map((folder) => folder.id)]);
      const liveVersions = taken.flatMap((item) =>
        item.liveVersion
          ? [{ documentId: item.documentId as DocumentId, version: item.liveVersion }]
          : [],
      );
      await Promise.all(
        pressed.map((draft) =>
          queryClient.cancelQueries({ queryKey: projectQueryKeys.drafts(projectId, draft) }),
        ),
      );
      const saw = lists[0]?.listed.saw;
      const record = await submitPress(live, {
        projectId,
        ...target.action,
        ...(saw ? { saw } : {}),
        ...(verdict === "apply" && liveVersions.length ? { liveVersions } : {}),
      });
      if (!record) {
        await refresh(scope);
        return "told";
      }
      const settled = await live.whenSettled(record.id);
      const landed = Date.now();
      await refresh(scope);
      if (settled?.state !== "done" || settled.outcome?.status !== "done") return "failed";
      const result = settled.outcome.result as PressResult;
      return {
        commandId: record.sendId,
        drafts: pressed,
        took: [...new Set([...result.documents, ...result.items.map((item) => item.node)])],
        placement,
        landed,
      };
    };

    const editorsOf = (documents: readonly string[], scope: Scope): EditorHistory[] => {
      const inScope = pressDrafts(scope);
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

    const run = (
      target: PressTarget,
      input: { documentId: string | null; name?: string | null },
      again?: EditorPressStep,
      heldRows?: HeldNoticeRows,
    ): Promise<CommandOutcome> => {
      const { verdict, scope } = target.action;
      const acting = pressDrafts(scope);
      if (!driver || acting.length === 0 || !acting.every(Boolean))
        return Promise.resolve("blocked");
      for (const key of [...drafts, ...(workWide ? [workKey] : [])]) notices.end(key);
      const noticeKey = noticeOf(scope);
      const editor =
        again ??
        new EditorPressStep(
          editorsOf(target.documents ?? rows(scope).map((row) => row.documentId), scope),
          (step) => run(target, input, step, heldRows),
        );
      let entry: PressEntry | null = null;
      // Named as listed now: the press takes the rows out of the list as it is sent.
      const names = new Map(rows(scope).map((row) => [row.documentId, nameOf(row.documentId)]));
      const named = (node: string) => names.get(node) ?? folderName(node);
      if (verdict === "discard" && target.whole) {
        const taken = target.documents && new Set(target.documents);
        const created = rows().flatMap((row) =>
          row.isNew && (!taken || taken.has(row.documentId)) ? [row.documentId] : [],
        );
        if (created.length > 0) removal?.beginOwnRemoval(projectId, created);
      }
      const outcome = press(target, driver).then((pressed): CommandOutcome => {
        if (typeof pressed === "string") return "blocked";
        const changed = pressed.took;
        if (changed.length === 0) return "settled";
        if (scope.kind === "turn") {
          entry = restoreInForce(scope, pressed, editor);
          return "done";
        }
        const where = noticeSurface(input.documentId, noticeKey);
        let shown: number | null = null;
        const step = remember(scope, verdict, pressed, editor, () => {
          if (shown !== null) notices.end(noticeKey, shown);
        });
        entry = step;
        if (verdict === "apply")
          shown = notices.showApplied({
            projectId,
            draftId: noticeKey,
            surface: where,
            change: scope.kind === "change",
            wholeDraft: scope.kind === "draft" || scope.kind === "work",
            documents: changed.map((documentId) => ({ documentId, name: named(documentId) })),
            undo: () => void step.undo(),
          });
        else {
          const [first] = changed;
          const documentId = input.documentId ?? first ?? "";
          shown = notices.showDiscard({
            projectId,
            draftId: noticeKey,
            surface: where,
            scope: scope.kind === "change" ? "change" : "draft",
            name: input.name ?? named(documentId),
            count: changed.length,
            documentIds: changed,
            undo: async () => (await step.undo()).ok,
          });
        }
        if (shown !== null) owner.holdNoticeRows(noticeKey, shown, heldRows);
        return "done";
      });
      editor.pressing(outcome.then(() => entry));
      return outcome;
    };

    const draftScope: PressScope = workWide
      ? { kind: "work", work: work.id as WorkId, drafts: drafts as DraftId[] }
      : { kind: "draft", draft: draftId as DraftId };
    const pressDocument = (verdict: Verdict, item: DraftItemRef, heldRows?: HeldNoticeRows) =>
      run(
        {
          action: { verdict, scope: { kind: "document", item: item.itemKey } },
          documents: [item.documentId],
          whole: true,
        },
        { documentId: item.documentId },
        undefined,
        heldRows,
      );
    const pressChange = (verdict: Verdict, item: DraftItemRef, change: string) =>
      run(
        {
          action: { verdict, scope: { kind: "change", item: item.itemKey, change } },
          documents: [item.documentId],
          whole: false,
        },
        { documentId: item.documentId },
      );
    const pressDraft = (verdict: Verdict, name: string | null = null, heldRows?: HeldNoticeRows) =>
      run(
        { action: { verdict, scope: draftScope }, documents: null, whole: true },
        {
          documentId: null,
          name,
        },
        undefined,
        heldRows,
      );
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
      void start.then(() => {
        if (owner.restore(turn, draft)?.kind === "sending") owner.setRestore(turn, draft, null);
      });
    };
    const undoRestore = (turn: TurnId, draft: DraftId) => {
      const entry = owner.restore(turn, draft);
      if (entry?.kind === "in-force") void entry.press.undo();
    };
    /**
     * What a read of the turn's card (`TurnReceiptChip.restored`, read at `readAt`) says is in
     * force in `draft`: `named`, a press id, or null for none; undefined before the card has a
     * read. A press this tab doesn't hold (another tab's, or one from before a reload) is taken on
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
        { commandId: named, drafts: [draft], took: [], placement: [], landed: readAt },
        new EditorPressStep([], () => {}),
      );
    };
    return {
      projectId,
      work,
      draftId,
      drafts,
      noticeKeys: workWide ? [workKey, ...drafts] : drafts,
      threadId,
      owner,
      dispositionLocked: locked,
      pressDocument,
      pressChange,
      pressDraft,
      restoreTurn,
      undoRestore,
      syncRestore,
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
export const WorkDraftCommandsBoundary = WorkDraftCommandsContext.Provider;
export function useBoundWorkDraftCommands(): WorkDraftCommands {
  const commands = useContext(WorkDraftCommandsContext);
  if (!commands) throw new Error("Work commands require a WorkDraftCommandsBoundary");
  return commands;
}
