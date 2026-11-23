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
import type { DocumentId, DraftId } from "@meridian/contracts";
import type {
  DraftItem,
  DraftItemsResponse,
  PressResult,
  PressScope,
} from "@meridian/contracts/drafts";
import type { TreeListRef } from "@meridian/contracts/protocol";
import type { Work } from "@meridian/contracts/works";
import { LIVE } from "@meridian/project-tree";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useMemo } from "react";
import { useCommandDriver } from "@/client/commands/driver-context";
import { pressLaneKey, submitPress, submitPressUndo } from "@/client/query/press-commands";
import { projectQueryKeys } from "@/client/query/project-query-keys";
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
import type { DraftItemRef } from "./useDraftReviewController";

type Verdict = "apply" | "discard";
/**
 * Each tree list whose rows showed the press's nodes in the Work's tree as it was sent, with the
 * sources they showed in: the sidebar stacks its Undo step goes on.
 */
type Placement = readonly { list: TreeListRef; sources: readonly string[] }[];
/** `took`: the documents and folders the press changed, in their text or their place in the tree. */
type Pressed = { commandId: string; lane: string; took: readonly string[]; placement: Placement };
/**
 * `failed`: the press reached the server, which didn't take it. `told`: it was never sent, and
 * `submitCommand` has told the writer already.
 */
type Unpressed = "failed" | "told";
/**
 * What a press takes, and the documents it expects to take whole (`null`: every row listed). A
 * change press takes part of a document: its row stays listed.
 */
type PressTarget = { scope: PressScope; documents: readonly string[] | null; whole: boolean };

export type CommandStart = { sent: boolean; outcome: Promise<CommandOutcome> };
export type WorkDraftCommands = ReturnType<typeof usePressCommands>;

export function usePressCommands({
  projectId,
  work,
  draftId,
  threadId = null,
  surface,
}: {
  projectId: string;
  /** The Work the draft belongs to, if any: the chat strip counts what its Changes list holds. */
  work: Work | null;
  /** The draft the commands act on; "" acts on none. */
  draftId: string;
  threadId?: string | null;
  /** Where this surface's notices show: the Changes list, a chat's strip, or a document's band. */
  surface: NoticeSurface["kind"];
}) {
  const owner = useDraftCommandOwner();
  const driver = useCommandDriver();
  const treeLists = useOptionalTreeLists();
  const removal = useOptionalContextRemovalCoordinator();
  const presented = useOptionalPresentedDocuments();
  const registry = useOptionalLiveDocumentSessionRegistry();
  const { openDraftFile } = useItemLauncher();
  const queryClient = useQueryClient();
  const locked = !draftId || !driver;
  return useMemo(() => {
    const { notices } = owner;
    const rows = () => cachedOwnerDrafts(queryClient, projectId, draftId) ?? [];
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
    /** Reads the list again; a row a press took or gave back shows once this lands. */
    const refresh = async () => {
      await queryClient.refetchQueries(
        { queryKey: projectQueryKeys.drafts(projectId, draftId) },
        { cancelRefetch: false },
      );
    };
    const blocked = (): CommandStart => ({
      sent: false,
      outcome: Promise.resolve({ kind: "blocked" }),
    });

    /** A press's Undo: the server takes back what that press did, and nothing else. */
    const unpress = async (commandId: string, lane: string): Promise<"done" | Unpressed> => {
      if (!driver) return "failed";
      const record = await submitPressUndo(driver, lane, {
        projectId,
        pressCommandId: commandId,
      });
      if (!record) return "told";
      const settled = await driver.whenSettled(record.id);
      await refresh();
      return settled?.state === "done" ? "done" : "failed";
    };

    /**
     * Where the nodes show in the Work's tree now, in the project's list and the account's: its
     * view shows both what Live holds and what the Work made. None found, the project's list
     * holds the step under every source.
     */
    const placementOf = (nodes: readonly string[]): Placement => {
      if (!treeLists) return [];
      const listed = queryClient.getQueryData<DraftItemsResponse>(
        projectQueryKeys.drafts(projectId, draftId),
      );
      const view = listed ? { draft: draftId } : LIVE;
      const project: TreeListRef = { kind: "project", projectId };
      const placement = [project, treeLists.account].flatMap((list) => {
        const handle = treeLists.acquire(list);
        const shown = handle.session.replay(view);
        handle.release();
        const sources = [...new Set(nodes.flatMap((node) => shownSourceOf(shown, node) ?? []))];
        return sources.length ? [{ list, sources }] : [];
      });
      return placement.length ? placement : [{ list: project, sources: [] }];
    };

    /** A folder's name as the Work's tree shows it, in the project's list or the account's. */
    const folderName = (node: string): string => {
      if (!treeLists) return "";
      for (const list of [{ kind: "project", projectId } as TreeListRef, treeLists.account]) {
        const handle = treeLists.acquire(list);
        const name = handle.session.replay({ draft: draftId }).nodes.get(node)?.name;
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
      verdict: Verdict,
      pressed: Pressed,
      editor: EditorPressStep,
      dropped: () => void,
    ): PressEntries => {
      const taken = pressed.took;
      const { seat, place } = seatOf(taken, async () => (await entries.undo()).kind !== "failed");
      place(pressed.placement);
      const port: PressPort = {
        unpress: async (commandId) => {
          // An Apply's Undo takes a created document out of Live: main, read before, follows it to
          // the draft's plain page, where it is a draft's document again.
          const main = presented?.mainDocumentId(projectId);
          const answer = await unpress(commandId, pressed.lane);
          if (answer !== "done")
            return answer === "told" ? { kind: "failed", told: true } : { kind: "failed" };
          const created = rows().find((row) => row.documentId === main && row.isNew);
          if (verdict === "apply" && created && main && taken.includes(main))
            for (const file of projectWorkDraftFiles([created], null)) openDraftFile(file, draftId);
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
          },
        },
        () => owner.presses.delete(entries),
      );
      owner.presses.add(entries);
      return entries;
    };

    /**
     * One press. Its rows and folders are in flight until the list is read again after it
     * (`DraftCommandOwner.hold`): they leave the list and the review, and nothing else can be
     * pressed on them. A row taken whole leaves the cached list too, so a read already out
     * can't bring it back; a press that fails gives it back with that read.
     */
    const press = async (
      verdict: Verdict,
      target: PressTarget,
      live: CommandDriver,
    ): Promise<Pressed | Unpressed> => {
      const listed = queryClient.getQueryData<DraftItemsResponse>(
        projectQueryKeys.drafts(projectId, draftId),
      );
      const all = target.documents === null;
      const nodes = target.documents ?? rows().map((item) => item.documentId);
      const taken = rows().filter((item) => all || nodes.includes(item.documentId));
      const gone = (item: DraftItem) => target.whole && (all || nodes.includes(item.documentId));
      const folders = listed && all ? listed.folders.map((folder) => folder.id) : [];
      // Discard all takes folders with only a tree change too: they have no row.
      const placement = placementOf([...nodes, ...folders]);
      const release = target.whole
        ? owner.hold(
            [...taken.map((item) => item.itemKey), ...folders.map((id) => folderKey(draftId, id))],
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
        await queryClient.cancelQueries({
          queryKey: projectQueryKeys.drafts(projectId, draftId),
        });
        patchOwnerDrafts(queryClient, projectId, draftId, (rowsNow) =>
          rowsNow.filter((item) => !gone(item)),
        );
        const record = await submitPress(live, {
          projectId,
          verdict,
          scope: target.scope,
          ...(listed?.saw ? { saw: listed.saw } : {}),
          ...(verdict === "apply" && liveVersions.length ? { liveVersions } : {}),
        });
        if (!record) return "told";
        const settled = await live.whenSettled(record.id);
        await refresh();
        if (settled?.state !== "done" || settled.outcome?.status !== "done") return "failed";
        const result = settled.outcome.result as PressResult;
        return {
          commandId: record.sendId,
          lane: pressLaneKey(target.scope),
          took: [...new Set([...result.documents, ...result.items.map((item) => item.node)])],
          placement,
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

    /** The Ctrl+Z of each editor showing one of the documents now, in this draft or in Live. */
    const editorsOf = (documents: readonly string[]): EditorHistory[] =>
      documents.flatMap((node) => {
        const documentId = node as DocumentId;
        const rooms = [
          { kind: "fork", draftId: draftId as DraftId, documentId },
          { kind: "live", documentId },
        ] as const;
        return rooms.flatMap((room) => {
          const history = registry?.openSession(room)?.history;
          return history?.open ? [history] : [];
        });
      });

    /** `again`: a Redo in an editor presses again, under the step it already has. */
    const run = (
      verdict: Verdict,
      target: PressTarget,
      input: { documentId: string | null; name?: string | null },
      again?: EditorPressStep,
    ): CommandStart => {
      if (locked || !driver) return blocked();
      notices.end(draftId);
      const editor =
        again ??
        new EditorPressStep(
          editorsOf(target.documents ?? rows().map((row) => row.documentId)),
          (step) => run(verdict, target, input, step),
        );
      let entries: PressEntries | null = null;
      // Named as listed now: the press takes the rows out of the list as it is sent.
      const names = new Map(rows().map((row) => [row.documentId, nameOf(row.documentId)]));
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
      const outcome = press(verdict, target, driver).then((pressed): CommandOutcome => {
        if (pressed === "failed")
          notifyFailure({
            key: `press:${draftId}`,
            title: verdict === "apply" ? t`Couldn't apply` : t`Couldn't discard`,
            brief: true,
          });
        if (typeof pressed === "string") return { kind: "blocked" };
        const sent = target.documents ?? pressed.took;
        const answer = outcomeOf(pressed, sent);
        if (answer.kind !== "done") return answer;
        const changed = pressed.took;
        const where = noticeSurface(input.documentId);
        let step: PressEntries;
        if (verdict === "apply") {
          step = remember("apply", pressed, editor, () => {
            if (notices.appliedFacts(draftId)?.facts.some((fact) => fact.step === step))
              notices.end(draftId);
          });
          notices.showApplied({
            projectId,
            draftId,
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
          step = remember("discard", pressed, editor, () => {
            // Taken back elsewhere (the sidebar, an editor): the notice's Undo goes with it.
            const notice = notices.get(draftId);
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
          shown = notices.showDiscard({ projectId, draftId, surface: where, parts: [part] });
        }
        entries = step;
        return { ...answer, undo: () => step.undo() };
      });
      editor.pressing(outcome.then(() => entries));
      return { sent: true, outcome };
    };

    const documentTarget = (item: DraftItemRef): PressTarget => ({
      scope: { kind: "document", item: item.itemKey },
      documents: [item.documentId],
      whole: true,
    });
    const draftTarget: PressTarget = {
      scope: { kind: "draft", draft: draftId as DraftId },
      documents: null,
      whole: true,
    };
    const startItem = (verdict: Verdict, item: DraftItemRef) =>
      run(verdict, documentTarget(item), { documentId: item.documentId });
    /** One change of a document, named by any of its members (`PressScope`'s `change`). */
    const startChange = (verdict: Verdict, item: DraftItemRef, change: string) =>
      run(
        verdict,
        {
          scope: { kind: "change", item: item.itemKey, change },
          documents: [item.documentId],
          whole: false,
        },
        { documentId: item.documentId },
      );
    /** The draft's files: one press on the whole draft; a single file presses that document. */
    const many = (verdict: Verdict, items: readonly DraftItemRef[]) => {
      const [only] = items;
      const target = items.length === 1 && only ? documentTarget(only) : draftTarget;
      return run(verdict, target, { documentId: only?.documentId ?? null }).outcome.then(
        (outcome) => items.map(() => outcome),
      );
    };
    const discardSelection = (input: {
      all?: boolean;
      items: readonly DraftItemRef[];
      name: string | null;
    }): Promise<CommandOutcome> => {
      const [only] = input.items;
      const target =
        !input.all && input.items.length === 1 && only ? documentTarget(only) : draftTarget;
      return run("discard", target, { documentId: only?.documentId ?? null, name: input.name })
        .outcome;
    };
    return {
      projectId,
      work,
      draftId,
      threadId,
      owner,
      dispositionLocked: locked,
      commandChange: (verdict: Verdict, item: DraftItemRef) => startItem(verdict, item).outcome,
      startItem: (verdict: Verdict, item: DraftItemRef) => startItem(verdict, item),
      startChange,
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
    draftId,
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
