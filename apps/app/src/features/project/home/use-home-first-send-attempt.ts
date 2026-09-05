/** Home-owned stable-ID creation joined to durable destination admission continuity. */
import type { Thread, ThreadListItem } from "@meridian/contracts/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { isMeridianApiError } from "@/client/api/http-client";
import { createProjectThread, listProjectThreads } from "@/client/api/projects-api";
import { useFirstSendContinuity } from "@/client/first-send-continuity";
import { invalidateWorkThreads } from "@/client/query/project-invalidation";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import type { ThreadStoreActions } from "@/client/stores";
import type { ComposerDraftChange, ComposerSubmitEnvelope } from "@/components/app/composer";
import { threadCreateAgentField, wireAgentSlug } from "@/features/agents";
import { deriveTitleFromMessage } from "@/lib/thread-title";

export type HomeFirstSendEnvelope = {
  threadId: string;
  projectId: string;
  submission: ComposerSubmitEnvelope;
  title: string;
  workId: string | null;
  agentSlug: string;
};
export type HomeFirstSendRefusal = "agent_not_found" | "work_unavailable";
export type HomeFirstSendLifecycle =
  | { kind: "idle" }
  | {
      kind: "creating" | "reconciling" | "refused" | "ambiguous" | "mismatched";
      envelope: HomeFirstSendEnvelope;
      refusal?: HomeFirstSendRefusal;
    }
  | { kind: "routing" | "route_failed"; envelope: HomeFirstSendEnvelope; thread: Thread };

type Dependencies = {
  projectId: string;
  actions: ThreadStoreActions;
  onSelectThread(threadId: string): Promise<void>;
  createThread?: typeof createProjectThread;
  listThreads?: typeof listProjectThreads;
  makeId?: () => string;
};

function deterministicRefusal(error: unknown): HomeFirstSendRefusal | null {
  if (!isMeridianApiError(error)) return null;
  return error.code === "agent_not_found" || error.code === "work_unavailable" ? error.code : null;
}
function matchesEnvelope(thread: Thread, envelope: HomeFirstSendEnvelope): boolean {
  return (
    thread.id === envelope.threadId &&
    thread.projectId === envelope.projectId &&
    thread.currentAgent === (wireAgentSlug(envelope.agentSlug) ?? null) &&
    thread.workId === envelope.workId
  );
}

export function useHomeFirstSendAttempt({
  projectId,
  actions,
  onSelectThread,
  createThread = createProjectThread,
  listThreads = listProjectThreads,
  makeId = () => crypto.randomUUID(),
}: Dependencies) {
  const queryClient = useQueryClient();
  const continuity = useFirstSendContinuity();
  const latestDraftRef = useRef<ComposerDraftChange | null>(null);
  const continuityQueue = useRef(Promise.resolve());
  const stateRef = useRef<HomeFirstSendLifecycle>({ kind: "idle" });
  const [state, setState] = useState<HomeFirstSendLifecycle>(stateRef.current);
  const transition = useCallback((next: HomeFirstSendLifecycle) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const route = useCallback(
    async (envelope: HomeFirstSendEnvelope, thread: Thread) => {
      transition({ kind: "routing", envelope, thread });
      try {
        await onSelectThread(thread.id);
        transition({ kind: "idle" });
        return true;
      } catch {
        transition({ kind: "route_failed", envelope, thread });
        return false;
      }
    },
    [onSelectThread, transition],
  );

  const prepareCanonical = useCallback(
    async (envelope: HomeFirstSendEnvelope, thread: Thread) => {
      if (!matchesEnvelope(thread, envelope)) {
        transition({ kind: "mismatched", envelope });
        return false;
      }
      actions.ensureThread(thread);
      const optimistic = actions.appendUserTurn(thread.id, envelope.submission.text);
      const latest = latestDraftRef.current?.snapshot;
      const key = {
        projectId,
        threadId: thread.id,
        submissionId: envelope.submission.submissionId,
      };
      continuityQueue.current = continuityQueue.current.then(() =>
        continuity.stage({
          ...key,
          envelope: envelope.submission,
          latestDraft:
            latest && latest.revision > envelope.submission.acceptedRevision ? latest : null,
          optimisticUserTurnId: optimistic.id,
          state: "ready",
        }),
      );
      try {
        await continuityQueue.current;
      } catch {
        actions.removeOptimisticUserTurn(thread.id, optimistic.id);
        transition({ kind: "ambiguous", envelope });
        return false;
      }
      if (thread.workId) void invalidateWorkThreads(queryClient, projectId, thread.workId);
      return route(envelope, thread);
    },
    [actions, continuity, projectId, queryClient, route, transition],
  );

  const reconcile = useCallback(
    async (envelope: HomeFirstSendEnvelope): Promise<ThreadListItem | null | undefined> => {
      transition({ kind: "reconciling", envelope });
      try {
        return (await listThreads(projectId)).find(({ id }) => id === envelope.threadId) ?? null;
      } catch {
        return undefined;
      }
    },
    [listThreads, projectId, transition],
  );

  const settleRefusal = useCallback(
    async (envelope: HomeFirstSendEnvelope, refusal: HomeFirstSendRefusal) => {
      await queryClient.refetchQueries({
        queryKey:
          refusal === "agent_not_found"
            ? projectQueryKeys.agents(projectId)
            : projectQueryKeys.works(projectId),
        exact: true,
      });
      transition({ kind: "refused", envelope, refusal });
      return false;
    },
    [projectId, queryClient, transition],
  );

  const create = useCallback(
    async function createAttempt(
      envelope: HomeFirstSendEnvelope,
      retryAfterKnownAbsence = true,
    ): Promise<boolean> {
      transition({ kind: "creating", envelope });
      try {
        const thread = await createThread(projectId, {
          id: envelope.threadId,
          title: envelope.title,
          workId: envelope.workId,
          ...threadCreateAgentField(envelope.agentSlug),
        });
        return prepareCanonical(envelope, thread);
      } catch (error) {
        const refusal = deterministicRefusal(error);
        if (refusal) return settleRefusal(envelope, refusal);
        const found = await reconcile(envelope);
        if (found) return prepareCanonical(envelope, found);
        if (found === null && retryAfterKnownAbsence) return createAttempt(envelope, false);
        transition({ kind: "ambiguous", envelope });
        return false;
      }
    },
    [createThread, prepareCanonical, projectId, reconcile, settleRefusal, transition],
  );

  const submit = useCallback(
    (submission: ComposerSubmitEnvelope, context: { workId: string | null; agentSlug: string }) => {
      if (stateRef.current.kind !== "idle") return Promise.resolve(false);
      return create({
        threadId: makeId(),
        projectId,
        submission,
        title: deriveTitleFromMessage(submission.text),
        ...context,
      });
    },
    [create, makeId, projectId],
  );

  const retry = useCallback(
    async (context: { workId: string | null; agentSlug: string }) => {
      const current = stateRef.current;
      if (current.kind === "refused") return create({ ...current.envelope, ...context });
      if (current.kind === "ambiguous") {
        const found = await reconcile(current.envelope);
        if (found) return prepareCanonical(current.envelope, found);
        if (found === null) return create(current.envelope);
        transition(current);
        return false;
      }
      if (current.kind === "route_failed") return route(current.envelope, current.thread);
      return false;
    },
    [create, prepareCanonical, reconcile, route, transition],
  );
  const startOver = useCallback(() => {
    if (stateRef.current.kind !== "mismatched") return false;
    transition({ kind: "idle" });
    return true;
  }, [transition]);

  const updateDraft = useCallback(
    (change: ComposerDraftChange) => {
      if (
        !latestDraftRef.current ||
        change.snapshot.revision > latestDraftRef.current.snapshot.revision
      )
        latestDraftRef.current = change;
      const current = stateRef.current;
      if (!("envelope" in current)) return;
      const key = {
        projectId,
        threadId: current.envelope.threadId,
        submissionId: current.envelope.submission.submissionId,
      };
      continuityQueue.current = continuityQueue.current.then(() =>
        continuity.updateLatest(key, change.snapshot),
      );
    },
    [continuity, projectId],
  );

  const busy =
    state.kind === "creating" || state.kind === "reconciling" || state.kind === "routing";
  return {
    state,
    busy,
    submit,
    retry,
    startOver,
    updateDraft,
    contextLocked: state.kind !== "idle" && state.kind !== "refused",
    submitLocked: state.kind !== "idle",
  };
}
