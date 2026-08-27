/** Home-owned stable-ID thread creation, reconciliation, and route handoff. */
import type { Thread, ThreadListItem } from "@meridian/contracts/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { isMeridianApiError } from "@/client/api/http-client";
import { createProjectThread, listProjectThreads } from "@/client/api/projects-api";
import { invalidateWorkThreads } from "@/client/query/project-invalidation";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import type { ThreadStoreActions } from "@/client/stores";
import { threadCreateAgentField, wireAgentSlug } from "@/features/agents";
import { deriveTitleFromMessage } from "@/lib/thread-title";

export type HomeFirstSendEnvelope = {
  threadId: string;
  projectId: string;
  text: string;
  draftRevision: number;
  title: string;
  workId: string;
  agentSlug: string;
};

export type HomeFirstSendRefusal = "agent_not_found" | "work_unavailable";

export type HomeFirstSendLifecycle =
  | { kind: "idle" }
  | { kind: "creating"; envelope: HomeFirstSendEnvelope }
  | { kind: "reconciling"; envelope: HomeFirstSendEnvelope }
  | { kind: "refused"; envelope: HomeFirstSendEnvelope; refusal: HomeFirstSendRefusal }
  | { kind: "ambiguous"; envelope: HomeFirstSendEnvelope }
  | { kind: "routing"; envelope: HomeFirstSendEnvelope; thread: Thread }
  | { kind: "route_failed"; envelope: HomeFirstSendEnvelope; thread: Thread }
  | { kind: "mismatched"; envelope: HomeFirstSendEnvelope };

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
  const expectedAgent = wireAgentSlug(envelope.agentSlug) ?? null;
  return (
    thread.id === envelope.threadId &&
    thread.projectId === envelope.projectId &&
    thread.currentAgent === expectedAgent &&
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
  const latestDraftRef = useRef({ text: "", revision: 0 });
  const stateRef = useRef<HomeFirstSendLifecycle>({ kind: "idle" });
  const [state, setState] = useState<HomeFirstSendLifecycle>(stateRef.current);

  const transition = useCallback((next: HomeFirstSendLifecycle) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const routeDraft = useCallback((envelope: HomeFirstSendEnvelope) => {
    const latest = latestDraftRef.current;
    return latest.revision > envelope.draftRevision ? latest.text : undefined;
  }, []);

  const route = useCallback(
    async (envelope: HomeFirstSendEnvelope, thread: Thread) => {
      transition({ kind: "routing", envelope, thread });
      actions.preserveFirstSendRouteDraft(thread.id, routeDraft(envelope));
      try {
        await onSelectThread(thread.id);
        actions.armFirstSend(thread.id);
        transition({ kind: "idle" });
        return true;
      } catch {
        transition({ kind: "route_failed", envelope, thread });
        return false;
      }
    },
    [actions, onSelectThread, routeDraft, transition],
  );

  const prepareCanonical = useCallback(
    async (envelope: HomeFirstSendEnvelope, thread: Thread) => {
      if (!matchesEnvelope(thread, envelope)) {
        transition({ kind: "mismatched", envelope });
        return false;
      }
      const draftAfterRoute = routeDraft(envelope);
      actions.ensureThread(thread);
      const optimistic = actions.appendUserTurn(thread.id, envelope.text);
      actions.stageFirstSend({
        threadId: thread.id,
        text: envelope.text,
        optimisticUserTurnId: optimistic.id,
        draftAfterRoute,
      });
      if (thread.workId) void invalidateWorkThreads(queryClient, projectId, thread.workId);
      return route(envelope, thread);
    },
    [actions, projectId, queryClient, route, routeDraft, transition],
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
    async function createAttempt(envelope: HomeFirstSendEnvelope, retryAfterKnownAbsence = true) {
      transition({ kind: "creating", envelope });
      const request = {
        id: envelope.threadId,
        title: envelope.title,
        workId: envelope.workId,
        ...threadCreateAgentField(envelope.agentSlug),
      };
      try {
        return await prepareCanonical(envelope, await createThread(projectId, request));
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
    (text: string, context: { workId: string; agentSlug: string }, draftRevision: number) => {
      if (stateRef.current.kind !== "idle") return Promise.resolve(false);
      const envelope: HomeFirstSendEnvelope = {
        threadId: makeId(),
        projectId,
        text,
        draftRevision,
        title: deriveTitleFromMessage(text),
        workId: context.workId,
        agentSlug: context.agentSlug,
      };
      latestDraftRef.current = { text, revision: draftRevision };
      return create(envelope);
    },
    [create, makeId, projectId],
  );

  const retry = useCallback(
    async (context: { workId: string; agentSlug: string }) => {
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
    (text: string, revision: number) => {
      latestDraftRef.current = { text, revision };
      const current = stateRef.current;
      if (current.kind === "routing" || current.kind === "route_failed") {
        actions.preserveFirstSendRouteDraft(
          current.envelope.threadId,
          routeDraft(current.envelope),
        );
      }
    },
    [actions, routeDraft],
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
