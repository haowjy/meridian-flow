/**
 * The commands of a Work's review surfaces (the Changes list, a chat's strip, a document's
 * band): every Apply and Discard of a document, a folder, a selection or the whole Work is one
 * press (`press-commands.ts`), run by the server over both halves, with one Undo.
 *
 * The rows a press takes leave the list as it is sent; a press that fails puts them back with a
 * pill. Its notice is the draft notice: a Discard's rows struck with Undo, an Apply's rows with
 * Undo, and both Undos are the press's.
 */
import { t } from "@lingui/core/macro";
import type { CommandDriver } from "@meridian/command-driver";
import type {
  PressResult,
  ThreadDraftListItem,
  ThreadDraftListResponse,
} from "@meridian/contracts/branches";
import type { Work } from "@meridian/contracts/works";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useMemo } from "react";
import { useCommandDriver } from "@/client/commands/driver-context";
import { submitPress, submitPressUndo } from "@/client/query/press-commands";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import {
  cachedOwnerDrafts,
  patchOwnerDrafts,
  useOwnerDraftsFrozen,
} from "@/client/query/useOwnerDrafts";
import { refreshTurnCards } from "@/client/query/useTurnLiveLineage";
import { documentBasename } from "@/client/query/work-branch-files";
import { notifyFailure } from "@/components/app/failure-toast";
import { ApplyEntries, type ApplyPort } from "@/features/draft-review/apply-history";
import { type CommandOutcome, folderKey } from "@/features/draft-review/draft-command-owner";
import type { DiscardPart, NoticeSurface } from "@/features/draft-review/draft-notices";
import type { DraftReviewSelection } from "@/features/draft-review/draft-review-session";
import type { ChangeTarget } from "@/features/draft-review/review-model";
import {
  useDraftCommandOwner,
  useLiveDocumentSessionRegistry,
} from "@/features/project/context/account-feature-context";

type Verdict = "apply" | "discard";
type Pressed = { commandId: string; result: PressResult };
/** A node the press takes: whole, or only its tree change (a review's tree line). */
type PressItem = { node: string; half?: "tree" };
const whole = (nodes: readonly string[]): PressItem[] => nodes.map((node) => ({ node }));

export type CommandStart = { sent: boolean; outcome: Promise<CommandOutcome> };
export type WorkBranchCommands = ReturnType<typeof usePressCommands>;

export function usePressCommands({
  projectId,
  work,
  ownerKey,
  threadId = null,
  surface,
}: {
  projectId: string;
  work: Work | null;
  /** Whose drafts the commands act on (`work:<id>` or `lineage:<root>`); "" acts on none. */
  ownerKey: string;
  threadId?: string | null;
  /** Where this surface's notices show: the Changes list, a chat's strip, or a document's band. */
  surface: NoticeSurface["kind"];
}) {
  const owner = useDraftCommandOwner();
  const driver = useCommandDriver();
  const registry = useLiveDocumentSessionRegistry();
  const queryClient = useQueryClient();
  const frozen = useOwnerDraftsFrozen(projectId, ownerKey);
  const locked = !ownerKey || !driver;
  return useMemo(() => {
    const { notices } = owner;
    const rows = () => cachedOwnerDrafts(queryClient, projectId, ownerKey) ?? [];
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
      refreshTurnCards(queryClient);
      await queryClient.refetchQueries(
        { queryKey: projectQueryKeys.ownerDrafts(projectId, ownerKey) },
        { cancelRefetch: false },
      );
    };
    const blocked = (): CommandStart => ({
      sent: false,
      outcome: Promise.resolve({ kind: "blocked" }),
    });

    /** A press's Undo: the server takes back what that press did, and nothing else. */
    const unpress = async (commandId: string): Promise<boolean> => {
      if (!driver) return false;
      const record = await submitPressUndo(driver, ownerKey, {
        projectId,
        pressCommandId: commandId,
      });
      const settled = record ? await driver.whenSettled(record.id) : null;
      await refresh();
      return settled?.state === "done";
    };

    /** A Discard's Undo, once: the notice and every row that offers it send this. */
    const undoOf = (commandId: string) => {
      let sent: Promise<boolean> | null = null;
      return () => {
        sent ??= unpress(commandId).then((done) => {
          if (done) return true;
          notifyFailure({ key: `unpress:${commandId}`, title: t`Couldn't undo`, brief: true });
          sent = null;
          return false;
        });
        return sent;
      };
    };

    /**
     * An Apply in the history of every editor open on its documents, as a draft's Apply is
     * (`ApplyEntries`): Ctrl+Z there, or a row's Undo, takes back the press; Redo presses again.
     */
    const remember = (pressed: Pressed): ApplyEntries => {
      const taken: PressItem[] = pressed.result.items.map((item) =>
        item.text ? { node: item.node } : { node: item.node, half: "tree" },
      );
      const port: ApplyPort = {
        unapply: async (commandId) =>
          (await unpress(commandId))
            ? { kind: "answered", unapplyId: commandId, took: true }
            : { kind: "failed" },
        redo: async () => {
          if (!driver) return "failed";
          const again = await press("apply", taken, driver);
          return again ? { commandId: again.commandId } : "failed";
        },
      };
      const entries: ApplyEntries = new ApplyEntries(
        pressed.commandId,
        port,
        () => taken.map(({ node }) => registry.history(node)),
        {
          push: () => {},
          // Taken back: its rows' Undo goes with it.
          drop: () => {
            if (notices.appliedFacts(ownerKey)?.facts.some((fact) => fact.step === entries))
              notices.end(ownerKey);
          },
        },
        () => owner.applied.delete(entries),
      );
      owner.applied.add(entries);
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
    ): Promise<Pressed | null> => {
      const listed = queryClient.getQueryData<ThreadDraftListResponse>(
        projectQueryKeys.ownerDrafts(projectId, ownerKey),
      );
      const nodes =
        items === "all" ? rows().map((item) => item.documentId) : items.map((item) => item.node);
      const gone = (item: ThreadDraftListItem) =>
        items === "all" ||
        items.some(({ node, half }) => node === item.documentId && half !== "tree");
      const rowKeys = rows().flatMap((item) =>
        nodes.includes(item.documentId) ? [item.itemKey] : [],
      );
      const folders = listed?.branchId
        ? nodes
            .filter((node) => !rows().some((item) => item.documentId === node))
            .map((node) => folderKey(listed.branchId as string, node))
        : [];
      const release = owner.hold([...rowKeys, ...folders], verdict === "apply");
      try {
        const open = nodes.flatMap((documentId) => {
          const vector = registry.openStateVector(documentId as never);
          return vector ? [{ documentId, vector: btoa(String.fromCharCode(...vector)) }] : [];
        });
        // A read already out answers from before the press: it must not bring the rows back.
        await queryClient.cancelQueries({
          queryKey: projectQueryKeys.ownerDrafts(projectId, ownerKey),
        });
        patchOwnerDrafts(queryClient, projectId, ownerKey, (rowsNow) =>
          rowsNow.filter((item) => !gone(item)),
        );
        const record = await submitPress(live, {
          projectId,
          owner: ownerKey,
          verdict,
          items: items === "all" ? "all" : [...items],
          ...(listed?.saw ? { saw: listed.saw } : {}),
          ...(open.length ? { seen: open } : {}),
        });
        const settled = record ? await live.whenSettled(record.id) : null;
        await refresh();
        if (!record || settled?.state !== "done" || settled.outcome?.status !== "done") {
          notifyFailure({
            key: `press:${ownerKey}`,
            title: verdict === "apply" ? t`Couldn't apply` : t`Couldn't discard`,
            brief: true,
          });
          return null;
        }
        return { commandId: record.sendId, result: settled.outcome.result as PressResult };
      } finally {
        release();
      }
    };

    /** What the press says of the nodes it was sent: the ones it changed nothing in are untaken. */
    const outcomeOf = (pressed: Pressed | null, nodes: readonly string[]): CommandOutcome => {
      if (!pressed) return { kind: "blocked" };
      const { result } = pressed;
      if (result.settled?.length) return { kind: "returned" };
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
      notices.end(ownerKey);
      // Named as listed now: the press takes the rows out of the list as it is sent.
      const names = new Map(rows().map((row) => [row.documentId, nameOf(row.documentId)]));
      const named = (node: string) => names.get(node) ?? "";
      const outcome = press(verdict, items, driver).then((pressed) => {
        const sent =
          items === "all"
            ? (pressed?.result.items.map((item) => item.node) ?? [])
            : items.map((item) => item.node);
        const answer = outcomeOf(pressed, sent);
        if (!pressed || answer.kind !== "done") return answer;
        const changed = pressed.result.items.map((item) => item.node);
        const where = noticeSurface(input.documentId);
        if (verdict === "apply") {
          const step = remember(pressed);
          notices.showApplied({
            projectId,
            ownerKey,
            surface: where,
            facts: changed.map((documentId) => ({
              documentId,
              kind: "applied" as const,
              name: named(documentId),
              step,
            })),
          });
        } else {
          const undo = undoOf(pressed.commandId);
          const [first] = changed;
          const part: DiscardPart = {
            documentId: input.documentId ?? first ?? "",
            name: input.name ?? named(input.documentId ?? first ?? ""),
            scope: input.folder ? "folder" : "draft",
            ...(changed.length > 1 ? { count: changed.length } : {}),
            covers: changed,
            handle: {
              undo: async () => ({
                answer: (await undo()) ? "ok" : "failed",
                landed: Promise.resolve(),
              }),
              end: () => {},
            },
          };
          notices.showDiscard({ projectId, ownerKey, surface: where, parts: [part] });
        }
        return answer;
      });
      return { sent: true, outcome };
    };

    /** A target of a tree line alone takes the node's tree change and leaves its text pending. */
    const itemOf = (documentId: string, target?: ChangeTarget): PressItem =>
      target?.kind === "tree" ? { node: documentId, half: "tree" } : { node: documentId };
    const startDraft = (verdict: Verdict, draft: DraftReviewSelection, target?: ChangeTarget) =>
      run(verdict, [itemOf(draft.documentId, target)], { documentId: draft.documentId });
    const many = (
      verdict: Verdict,
      items: readonly { draft: DraftReviewSelection; target: ChangeTarget }[],
      folders: readonly string[] = [],
    ) => {
      const sent = [
        ...whole(folders),
        ...items.map(({ draft, target }) => itemOf(draft.documentId, target)),
      ];
      return run(verdict, sent, { documentId: items[0]?.draft.documentId ?? null }).outcome.then(
        (outcome) => items.map(() => outcome),
      );
    };
    const discardSelection = (input: {
      all?: boolean;
      drafts: readonly DraftReviewSelection[];
      folders: readonly string[];
      name: string | null;
    }): Promise<CommandOutcome> =>
      run(
        "discard",
        input.all
          ? "all"
          : whole([...input.folders, ...input.drafts.map((draft) => draft.documentId)]),
        {
          documentId: input.drafts[0]?.documentId ?? null,
          name: input.name,
          folder: input.name !== null && input.folders.length > 0,
        },
      ).outcome;
    return {
      projectId,
      work,
      ownerKey,
      threadId,
      owner,
      dispositionLocked: locked,
      changesLocked: locked || frozen,
      frozen,
      canApply: !frozen,
      /**
       * One change in the text is the editor's (`useSuggestionChanges`); a list's row is the
       * document, and a tree line its tree change alone.
       */
      commandChange: (verdict: Verdict, draft: DraftReviewSelection, target: ChangeTarget) =>
        startDraft(verdict, draft, target).outcome,
      startDraft: (verdict: Verdict, draft: DraftReviewSelection) => startDraft(verdict, draft),
      apply: (documentId: string, itemKey: string) =>
        startDraft("apply", { documentId, itemKey }).outcome,
      discard: (documentId: string, itemKey: string) =>
        startDraft("discard", { documentId, itemKey }).outcome,
      applyMany: (
        items: readonly { draft: DraftReviewSelection; target: ChangeTarget }[],
        folders: readonly string[] = [],
      ) => many("apply", items, folders),
      discardMany: (items: readonly { draft: DraftReviewSelection; target: ChangeTarget }[]) =>
        many("discard", items),
      discardSelection,
      discardAll: (
        drafts: readonly DraftReviewSelection[],
        folders: readonly string[],
        name: string | null,
      ) => discardSelection({ all: true, drafts, folders, name }),
    };
  }, [
    owner,
    driver,
    registry,
    queryClient,
    frozen,
    locked,
    projectId,
    work,
    ownerKey,
    threadId,
    surface,
  ]);
}

const WorkBranchCommandsContext = createContext<WorkBranchCommands | null>(null);
/** One surface's commands for the surfaces under it (`useBoundWorkBranchCommands`). */
export const WorkBranchCommandsBoundary = WorkBranchCommandsContext.Provider;
export function useBoundWorkBranchCommands(): WorkBranchCommands {
  const commands = useContext(WorkBranchCommandsContext);
  if (!commands) throw new Error("Work commands require a WorkBranchCommandsBoundary");
  return commands;
}
