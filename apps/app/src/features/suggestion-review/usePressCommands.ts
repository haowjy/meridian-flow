/**
 * Suggestion mode's commands for a Work's review surfaces (the Changes list, a chat's strip, a
 * document's band): every Apply and Discard of a document, a folder, a selection or the whole
 * Work is one press (`press-commands.ts`), run by the server over both halves, with one Undo.
 * It answers in the shape the draft commands do (`WorkBranchCommands`), so those surfaces don't
 * know which one runs.
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
import { useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
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
import type { CommandOutcome } from "@/features/draft-review/draft-command-owner";
import type { DiscardPart, NoticeSurface } from "@/features/draft-review/draft-notices";
import type { DraftReviewSelection } from "@/features/draft-review/draft-review-session";
import type { ChangeTarget } from "@/features/draft-review/review-model";
import type {
  CommandStart,
  WorkBranchCommands,
  WorkBranchCommandsInput,
} from "@/features/draft-review/useWorkBranchCommands";
import {
  useDraftCommandOwner,
  useLiveDocumentSessionRegistry,
} from "@/features/project/context/account-feature-context";

type Verdict = "apply" | "discard";
type Pressed = { commandId: string; result: PressResult };

export function usePressCommands({
  projectId,
  work,
  ownerKey,
  threadId = null,
  surface,
}: WorkBranchCommandsInput): WorkBranchCommands {
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
    const refresh = () => {
      refreshTurnCards(queryClient);
      void queryClient.invalidateQueries({
        queryKey: projectQueryKeys.ownerDrafts(projectId, ownerKey),
      });
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
      refresh();
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
    const remember = (pressed: Pressed, nodes: readonly string[]): ApplyEntries => {
      const port: ApplyPort = {
        unapply: async (commandId) =>
          (await unpress(commandId))
            ? { kind: "answered", unapplyId: commandId, took: true }
            : { kind: "failed" },
        redo: async () => {
          if (!driver) return "failed";
          const again = await press("apply", nodes, driver);
          return again ? { commandId: again.commandId } : "failed";
        },
      };
      const entries: ApplyEntries = new ApplyEntries(
        pressed.commandId,
        port,
        () => nodes.map((node) => registry.history(node)),
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
     * One press. The rows it names leave the list at once (all of them for `"all"`), and come back
     * on the next read if it fails. `documents`: the documents among `nodes`, whose open copies
     * the server must hold before it runs.
     */
    const press = async (
      verdict: Verdict,
      nodes: readonly string[] | "all",
      live: CommandDriver,
    ): Promise<Pressed | null> => {
      const taken = (item: ThreadDraftListItem) =>
        nodes === "all" || nodes.includes(item.documentId);
      const open = (nodes === "all" ? rows().map((item) => item.documentId) : nodes).flatMap(
        (documentId) => {
          const vector = registry.openStateVector(documentId as never);
          return vector ? [{ documentId, vector: btoa(String.fromCharCode(...vector)) }] : [];
        },
      );
      const saw = queryClient.getQueryData<ThreadDraftListResponse>(
        projectQueryKeys.ownerDrafts(projectId, ownerKey),
      )?.saw;
      // A read already out answers from before the press: it must not bring the rows back.
      await queryClient.cancelQueries({
        queryKey: projectQueryKeys.ownerDrafts(projectId, ownerKey),
      });
      patchOwnerDrafts(queryClient, projectId, ownerKey, (items) =>
        items.filter((item) => !taken(item)),
      );
      const record = await submitPress(live, {
        projectId,
        owner: ownerKey,
        verdict,
        items: nodes === "all" ? "all" : nodes.map((node) => ({ node })),
        ...(saw ? { saw } : {}),
        ...(open.length ? { seen: open } : {}),
      });
      const settled = record ? await live.whenSettled(record.id) : null;
      refresh();
      if (!record || settled?.state !== "done" || settled.outcome?.status !== "done") {
        notifyFailure({
          key: `press:${ownerKey}`,
          title: verdict === "apply" ? t`Couldn't apply` : t`Couldn't discard`,
          brief: true,
        });
        return null;
      }
      return { commandId: record.sendId, result: settled.outcome.result as PressResult };
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
      nodes: readonly string[] | "all",
      input: { documentId: string | null; name?: string | null; folder?: boolean },
    ): CommandStart => {
      if (locked || !driver) return blocked();
      notices.end(ownerKey);
      // Named as listed now: the press takes the rows out of the list as it is sent.
      const names = new Map(rows().map((row) => [row.documentId, nameOf(row.documentId)]));
      const named = (node: string) => names.get(node) ?? "";
      const outcome = press(verdict, nodes, driver).then((pressed) => {
        const sent =
          nodes === "all" ? (pressed?.result.items.map((item) => item.node) ?? []) : nodes;
        const answer = outcomeOf(pressed, sent);
        if (!pressed || answer.kind !== "done") return answer;
        const changed = pressed.result.items.map((item) => item.node);
        const where = noticeSurface(input.documentId);
        if (verdict === "apply") {
          const step = remember(pressed, changed);
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

    const startDraft = (verdict: Verdict, draft: DraftReviewSelection) =>
      run(verdict, [draft.documentId], { documentId: draft.documentId });
    const many = (
      verdict: Verdict,
      items: readonly { draft: DraftReviewSelection }[],
      folders: readonly string[] = [],
    ) => {
      const nodes = [...folders, ...items.map(({ draft }) => draft.documentId)];
      return run(verdict, nodes, { documentId: items[0]?.draft.documentId ?? null }).outcome.then(
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
        input.all ? "all" : [...input.folders, ...input.drafts.map((draft) => draft.documentId)],
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
      /** One change in the text is the editor's (`useSuggestionChanges`); a list's row is the document. */
      commandChange: (verdict: Verdict, draft: DraftReviewSelection, _target: ChangeTarget) =>
        startDraft(verdict, draft).outcome,
      startDraft,
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
