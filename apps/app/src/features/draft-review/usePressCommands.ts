/**
 * The commands of a Work's review surfaces (the Changes list, a chat's strip, a document's
 * band): every Apply and Discard of a document, a folder, a selection or the whole Work is one
 * press (`press-commands.ts`), run by the server over both halves, with one Undo.
 *
 * The rows a press takes leave the list as it is sent; a press that fails puts them back with a
 * pill. Its notice is the draft notice: a Discard's rows struck with Undo, an Apply's rows with
 * Undo. Each press is one step on the sidebar's Undo stack too (`PressStep`), and every Undo of
 * it, there, on its notice or in an editor, is the press's one Undo.
 */
import { t } from "@lingui/core/macro";
import type { CommandDriver } from "@meridian/command-driver";
import type { CommandId } from "@meridian/contracts";
import type { DraftItem, DraftItemsResponse, PressResult } from "@meridian/contracts/drafts";
import type { TreeListRef } from "@meridian/contracts/protocol";
import type { Work } from "@meridian/contracts/works";
import { LIVE } from "@meridian/project-tree";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useMemo } from "react";
import { useCommandDriver } from "@/client/commands/driver-context";
import { submitPress, submitPressUndo } from "@/client/query/press-commands";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { cachedOwnerDrafts, patchOwnerDrafts } from "@/client/query/useOwnerDrafts";
import { documentBasename } from "@/client/query/work-draft-files";
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
  useLiveDocumentSessionRegistry,
  useOptionalContextRemovalCoordinator,
  useOptionalTreeLists,
} from "@/features/project/context/account-feature-context";
import { type CommandOutcome, folderKey } from "./draft-command-owner";
import type { DiscardPart, NoticeSurface } from "./draft-notices";
import type { DraftItemRef } from "./draft-review-session";
import { PressEntries, type PressPort, type Seat } from "./press-history";
import type { ChangeTarget } from "./review-model";

type Verdict = "apply" | "discard";
/**
 * Each tree list whose rows showed the press's nodes in the Work's tree as it was sent, with the
 * sources they showed in: the sidebar stacks its Undo step goes on.
 */
type Placement = readonly { list: TreeListRef; sources: readonly string[] }[];
type Pressed = { commandId: string; result: PressResult; placement: Placement };
/**
 * `failed`: the press reached the server, which didn't take it. `told`: it was never sent, and
 * `submitCommand` has told the writer already.
 */
type Unpressed = "failed" | "told";
/** A node the press takes: whole, or only its tree change (a review's tree line). */
type PressItem = { node: string; half?: "tree" };
const whole = (nodes: readonly string[]): PressItem[] => nodes.map((node) => ({ node }));

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
  const registry = useLiveDocumentSessionRegistry();
  const treeLists = useOptionalTreeLists();
  const removal = useOptionalContextRemovalCoordinator();
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
    const unpress = async (commandId: string): Promise<"done" | Unpressed> => {
      if (!driver) return "failed";
      const record = await submitPressUndo(driver, draftId, {
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
     * A press in the history of every editor open on its documents and on the sidebar's stack
     * (`PressEntries`): Ctrl+Z in either, or its notice's Undo, takes back the press once; an
     * editor's Redo presses again. `dropped`: it was taken back, and its notice goes with it.
     */
    const remember = (verdict: Verdict, pressed: Pressed, dropped: () => void): PressEntries => {
      const taken: PressItem[] = pressed.result.items.map((item) =>
        item.text ? { node: item.node } : { node: item.node, half: "tree" },
      );
      const { seat, place } = seatOf(
        taken.map(({ node }) => node),
        async () => (await entries.undo(null)).kind !== "failed",
      );
      place(pressed.placement);
      // The press in force, which a Redo presses again.
      let inForce = pressed.commandId;
      const port: PressPort = {
        unpress: async (commandId) => {
          const answer = await unpress(commandId);
          if (answer === "done") return { kind: "answered", unpressId: commandId, took: true };
          return answer === "told" ? { kind: "failed", told: true } : { kind: "failed" };
        },
        redo: async () => {
          if (!driver) return "failed";
          const again = await press(verdict, taken, driver, inForce);
          if (again === "told") return null;
          if (again === "failed") return "failed";
          place(again.placement);
          inForce = again.commandId;
          return { commandId: again.commandId };
        },
      };
      const entries: PressEntries = new PressEntries(
        pressed.commandId,
        port,
        () => taken.map(({ node }) => registry.history(node)),
        {
          push: seat.push,
          drop: () => {
            seat.drop();
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
      items: readonly PressItem[] | "all",
      live: CommandDriver,
      redoes?: string,
    ): Promise<Pressed | Unpressed> => {
      const listed = queryClient.getQueryData<DraftItemsResponse>(
        projectQueryKeys.drafts(projectId, draftId),
      );
      const nodes =
        items === "all" ? rows().map((item) => item.documentId) : items.map((item) => item.node);
      const gone = (item: DraftItem) =>
        items === "all" ||
        items.some(({ node, half }) => node === item.documentId && half !== "tree");
      const rowKeys = rows().flatMap((item) =>
        nodes.includes(item.documentId) ? [item.itemKey] : [],
      );
      const folders = listed
        ? nodes
            .filter((node) => !rows().some((item) => item.documentId === node))
            .map((node) => folderKey(draftId, node))
        : [];
      // Discard all takes folders with only a tree change too: they have no row.
      const placement = placementOf(
        items === "all" ? [...nodes, ...(listed?.folders.map((folder) => folder.id) ?? [])] : nodes,
      );
      const release = owner.hold([...rowKeys, ...folders], verdict === "apply");
      try {
        // Every room with unsent typing, not only the pressed rows: a press finds documents the
        // list hasn't.
        const open = [...registry.unsentStateVectors()].map(([documentId, vector]) => ({
          documentId,
          vector: btoa(String.fromCharCode(...vector)),
        }));
        // A read already out answers from before the press: it must not bring the rows back.
        await queryClient.cancelQueries({
          queryKey: projectQueryKeys.drafts(projectId, draftId),
        });
        patchOwnerDrafts(queryClient, projectId, draftId, (rowsNow) =>
          rowsNow.filter((item) => !gone(item)),
        );
        const record = await submitPress(live, {
          projectId,
          draft: draftId,
          verdict,
          items: items === "all" ? "all" : [...items],
          ...(listed?.saw ? { saw: listed.saw } : {}),
          ...(open.length ? { seen: open } : {}),
          ...(redoes ? { redoes: redoes as CommandId } : {}),
        });
        if (!record) return "told";
        const settled = await live.whenSettled(record.id);
        await refresh();
        if (settled?.state !== "done" || settled.outcome?.status !== "done") return "failed";
        return {
          commandId: record.sendId,
          result: settled.outcome.result as PressResult,
          placement,
        };
      } finally {
        release();
      }
    };

    /** What the press says of the nodes it was sent: the ones it changed nothing in are untaken. */
    const outcomeOf = (pressed: Pressed, nodes: readonly string[]): CommandOutcome => {
      const { result } = pressed;
      const took = new Set(result.items.map((item) => item.node));
      const untaken = nodes.filter((node) => !took.has(node));
      return took.size > 0
        ? { kind: "done", commandId: pressed.commandId, took: { untaken } }
        : { kind: "settled", took: { untaken } };
    };

    const run = (
      verdict: Verdict,
      items: readonly PressItem[] | "all",
      input: { documentId: string | null; name?: string | null; folder?: boolean },
    ): CommandStart => {
      if (locked || !driver) return blocked();
      notices.end(draftId);
      // Named as listed now: the press takes the rows out of the list as it is sent.
      const names = new Map(rows().map((row) => [row.documentId, nameOf(row.documentId)]));
      const named = (node: string) => names.get(node) ?? "";
      // A document the Work created goes to Trash with its Discard: main leaves it first.
      if (verdict === "discard") {
        const taken = items === "all" ? null : new Set(items.map((item) => item.node));
        const created = rows().flatMap((row) =>
          row.isNew && (!taken || taken.has(row.documentId)) ? [row.documentId] : [],
        );
        if (created.length > 0) removal?.beginOwnRemoval(projectId, created);
      }
      const outcome = press(verdict, items, driver).then((pressed): CommandOutcome => {
        if (pressed === "failed")
          notifyFailure({
            key: `press:${draftId}`,
            title: verdict === "apply" ? t`Couldn't apply` : t`Couldn't discard`,
            brief: true,
          });
        if (typeof pressed === "string") return { kind: "blocked" };
        const sent =
          items === "all"
            ? pressed.result.items.map((item) => item.node)
            : items.map((item) => item.node);
        const answer = outcomeOf(pressed, sent);
        if (answer.kind !== "done") return answer;
        const changed = pressed.result.items.map((item) => item.node);
        const where = noticeSurface(input.documentId);
        if (verdict === "apply") {
          const step = remember("apply", pressed, () => {
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
          const step = remember("discard", pressed, () => {
            // Taken back elsewhere (the sidebar, an editor): the notice's Undo goes with it.
            const notice = notices.get(draftId);
            if (notice?.id === shown && notice.kind === "discarded" && notice.status === "ready")
              notice.dismiss();
          });
          const [first] = changed;
          const part: DiscardPart = {
            documentId: input.documentId ?? first ?? "",
            name: input.name ?? named(input.documentId ?? first ?? ""),
            scope: input.folder ? "folder" : "draft",
            ...(changed.length > 1 ? { count: changed.length } : {}),
            covers: changed,
            handle: {
              undo: async () => ({
                answer: (await step.undo(null)).kind === "failed" ? "failed" : "ok",
                landed: Promise.resolve(),
              }),
              end: () => {},
            },
          };
          shown = notices.showDiscard({ projectId, draftId, surface: where, parts: [part] });
        }
        return answer;
      });
      return { sent: true, outcome };
    };

    /** A target of a tree line alone takes the node's tree change and leaves its text pending. */
    const itemOf = (documentId: string, target?: ChangeTarget): PressItem =>
      target?.kind === "tree" ? { node: documentId, half: "tree" } : { node: documentId };
    const startItem = (verdict: Verdict, item: DraftItemRef, target?: ChangeTarget) =>
      run(verdict, [itemOf(item.documentId, target)], { documentId: item.documentId });
    const many = (
      verdict: Verdict,
      items: readonly { item: DraftItemRef; target: ChangeTarget }[],
      folders: readonly string[] = [],
    ) => {
      const sent = [
        ...whole(folders),
        ...items.map(({ item, target }) => itemOf(item.documentId, target)),
      ];
      return run(verdict, sent, { documentId: items[0]?.item.documentId ?? null }).outcome.then(
        (outcome) => items.map(() => outcome),
      );
    };
    const discardSelection = (input: {
      all?: boolean;
      items: readonly DraftItemRef[];
      folders: readonly string[];
      name: string | null;
    }): Promise<CommandOutcome> =>
      run(
        "discard",
        input.all
          ? "all"
          : whole([...input.folders, ...input.items.map((item) => item.documentId)]),
        {
          documentId: input.items[0]?.documentId ?? null,
          name: input.name,
          folder: input.name !== null && input.folders.length > 0,
        },
      ).outcome;
    return {
      projectId,
      work,
      draftId,
      threadId,
      owner,
      dispositionLocked: locked,
      /**
       * One change in the text is the editor's (`useSuggestionChanges`); a list's row is the
       * document, and a tree line its tree change alone.
       */
      commandChange: (verdict: Verdict, item: DraftItemRef, target: ChangeTarget) =>
        startItem(verdict, item, target).outcome,
      startItem: (verdict: Verdict, item: DraftItemRef) => startItem(verdict, item),
      apply: (documentId: string, itemKey: string) =>
        startItem("apply", { documentId, itemKey }).outcome,
      discard: (documentId: string, itemKey: string) =>
        startItem("discard", { documentId, itemKey }).outcome,
      applyMany: (
        items: readonly { item: DraftItemRef; target: ChangeTarget }[],
        folders: readonly string[] = [],
      ) => many("apply", items, folders),
      discardMany: (items: readonly { item: DraftItemRef; target: ChangeTarget }[]) =>
        many("discard", items),
      discardSelection,
      discardAll: (
        items: readonly DraftItemRef[],
        folders: readonly string[],
        name: string | null,
      ) => discardSelection({ all: true, items, folders, name }),
    };
  }, [
    owner,
    driver,
    registry,
    treeLists,
    removal,
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
