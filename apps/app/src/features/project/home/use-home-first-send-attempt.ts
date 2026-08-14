/** Home-owned stable-ID thread creation, reconciliation, and route handoff. */
import type { Thread, ThreadListItem } from "@meridian/contracts/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { HttpResponseError, isMeridianApiError } from "@/client/api/http-client";
import { createProjectThread, listProjectThreads } from "@/client/api/projects-api";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { prepareCreatedThreadVisibility } from "@/client/query/visible-thread-open-acknowledgements";
import type { ThreadStoreActions } from "@/client/stores";
import { threadCreateAgentField, wireAgentSlug } from "@/features/agents";
import { deriveTitleFromMessage } from "@/lib/thread-title";

export type HomeWorkSelection =
  | { source: "current_default"; displayedWorkId: string }
  | { source: "writer"; workId: string };

export type HomeFirstSendEnvelope = {
  threadId: string;
  projectId: string;
  text: string;
  draftRevision: number;
  title: string;
  work: HomeWorkSelection;
  agentSlug: string;
  phase: "creating" | "routing" | "failed_create" | "failed_route";
  canonicalThread: Thread | null;
};

type Failure = "create" | "route" | "mismatch";

type Dependencies = {
  projectId: string;
  actions: ThreadStoreActions;
  onSelectThread(threadId: string): Promise<void>;
  createThread?: typeof createProjectThread;
  listThreads?: typeof listProjectThreads;
  makeId?: () => string;
};

function isAuthoritativeRefusal(error: unknown): boolean {
  return (
    error instanceof HttpResponseError || (isMeridianApiError(error) && error.status !== undefined)
  );
}

function matchesEnvelope(thread: Thread, envelope: HomeFirstSendEnvelope): boolean {
  const expectedAgent = wireAgentSlug(envelope.agentSlug) ?? null;
  return (
    thread.id === envelope.threadId &&
    thread.projectId === envelope.projectId &&
    thread.currentAgent === expectedAgent &&
    thread.workId ===
      (envelope.work.source === "current_default"
        ? envelope.work.displayedWorkId
        : envelope.work.workId)
  );
}

function refusedCatalog(error: unknown): "agent" | "work" | "both" {
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("Agent not found:")) return "agent";
  if (message.includes("Work")) return "work";
  return "both";
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
  const attemptRef = useRef<HomeFirstSendEnvelope | null>(null);
  const latestDraftRef = useRef({ text: "", revision: 0 });
  const singleFlightRef = useRef(false);
  const [attempt, setAttempt] = useState<HomeFirstSendEnvelope | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);

  const publish = useCallback((next: HomeFirstSendEnvelope) => {
    attemptRef.current = next;
    setAttempt(next);
  }, []);

  const routeDraft = useCallback((envelope: HomeFirstSendEnvelope) => {
    const latest = latestDraftRef.current;
    return latest.revision > envelope.draftRevision ? latest.text : undefined;
  }, []);

  const route = useCallback(
    async (envelope: HomeFirstSendEnvelope) => {
      const thread = envelope.canonicalThread;
      if (!thread) return false;
      const routing = { ...envelope, phase: "routing" as const };
      publish(routing);
      actions.preserveFirstSendRouteDraft(thread.id, routeDraft(envelope));
      try {
        await onSelectThread(thread.id);
        actions.armFirstSend(thread.id);
        setFailure(null);
        attemptRef.current = null;
        setAttempt(null);
        return true;
      } catch {
        publish({ ...routing, phase: "failed_route" });
        setFailure("route");
        return false;
      }
    },
    [actions, onSelectThread, publish, routeDraft],
  );

  const prepareCanonical = useCallback(
    async (envelope: HomeFirstSendEnvelope, thread: Thread) => {
      if (!matchesEnvelope(thread, envelope)) {
        publish({ ...envelope, phase: "failed_create" });
        setFailure("mismatch");
        return false;
      }
      const canonical = { ...envelope, canonicalThread: thread, phase: "routing" as const };
      const draftAfterRoute = routeDraft(envelope);
      actions.ensureThread(thread);
      const optimistic = actions.appendUserTurn(thread.id, envelope.text);
      actions.stageFirstSend({
        threadId: thread.id,
        text: envelope.text,
        optimisticUserTurnId: optimistic.id,
        draftAfterRoute,
      });
      prepareCreatedThreadVisibility(queryClient, {
        projectId: envelope.projectId,
        threadId: thread.id,
      });
      publish(canonical);
      return route(canonical);
    },
    [actions, publish, queryClient, route, routeDraft],
  );

  const reconcile = useCallback(
    async (envelope: HomeFirstSendEnvelope): Promise<ThreadListItem | null | undefined> => {
      try {
        const found = (await listThreads(projectId)).find(({ id }) => id === envelope.threadId);
        return found ?? null;
      } catch {
        return undefined;
      }
    },
    [listThreads, projectId],
  );

  const settleAuthoritativeRefusal = useCallback(
    async (envelope: HomeFirstSendEnvelope, error: unknown) => {
      publish({ ...envelope, phase: "failed_create" });
      const catalog = refusedCatalog(error);
      await Promise.all([
        catalog !== "agent"
          ? queryClient.refetchQueries({
              queryKey: projectQueryKeys.works(projectId),
              exact: true,
            })
          : Promise.resolve(),
        catalog !== "work"
          ? queryClient.refetchQueries({
              queryKey: projectQueryKeys.agents(projectId),
              exact: true,
            })
          : Promise.resolve(),
      ]);
      setFailure("create");
      return false;
    },
    [projectId, publish, queryClient],
  );

  const create = useCallback(
    async (envelope: HomeFirstSendEnvelope) => {
      const request = {
        id: envelope.threadId,
        title: envelope.title,
        ...(envelope.work.source === "writer" ? { workId: envelope.work.workId } : {}),
        ...threadCreateAgentField(envelope.agentSlug),
      };
      try {
        return await prepareCanonical(envelope, await createThread(projectId, request));
      } catch (error) {
        if (isAuthoritativeRefusal(error)) {
          return settleAuthoritativeRefusal(envelope, error);
        }
        const reconciled = await reconcile(envelope);
        if (reconciled) return prepareCanonical(envelope, reconciled);
        if (reconciled === null) {
          try {
            return await prepareCanonical(envelope, await createThread(projectId, request));
          } catch (retryError) {
            if (isAuthoritativeRefusal(retryError)) {
              return settleAuthoritativeRefusal(envelope, retryError);
            }
            const afterRetry = await reconcile(envelope);
            if (afterRetry) return prepareCanonical(envelope, afterRetry);
          }
        }
        publish({ ...envelope, phase: "failed_create" });
        setFailure("create");
        return false;
      }
    },
    [createThread, prepareCanonical, projectId, publish, reconcile, settleAuthoritativeRefusal],
  );

  const run = useCallback(async (operation: () => Promise<boolean>) => {
    if (singleFlightRef.current) return false;
    singleFlightRef.current = true;
    setBusy(true);
    try {
      return await operation();
    } finally {
      singleFlightRef.current = false;
      setBusy(false);
    }
  }, []);

  const submit = useCallback(
    (
      text: string,
      context: { work: HomeWorkSelection; agentSlug: string },
      draftRevision: number,
    ) =>
      run(async () => {
        if (attemptRef.current) return false;
        const envelope: HomeFirstSendEnvelope = {
          threadId: makeId(),
          projectId,
          text,
          draftRevision,
          title: deriveTitleFromMessage(text),
          work: context.work,
          agentSlug: context.agentSlug,
          phase: "creating",
          canonicalThread: null,
        };
        latestDraftRef.current = { text, revision: draftRevision };
        publish(envelope);
        setFailure(null);
        return create(envelope);
      }),
    [create, makeId, projectId, publish, run],
  );

  const retry = useCallback(
    (context: { work: HomeWorkSelection; agentSlug: string }) =>
      run(async () => {
        const envelope = attemptRef.current;
        if (!envelope || failure === "mismatch") return false;
        setFailure(null);
        return envelope.canonicalThread
          ? route(envelope)
          : create({ ...envelope, ...context, phase: "creating" });
      }),
    [create, failure, route, run],
  );

  const updateDraft = useCallback(
    (text: string, revision: number) => {
      latestDraftRef.current = { text, revision };
      const envelope = attemptRef.current;
      if (envelope?.canonicalThread) {
        actions.preserveFirstSendRouteDraft(envelope.threadId, routeDraft(envelope));
      }
    },
    [actions, routeDraft],
  );

  const contextRepair = attempt?.phase === "failed_create" && failure === "create";
  return {
    attempt,
    busy,
    failure,
    submit,
    retry,
    updateDraft,
    contextLocked: attempt !== null && !contextRepair,
    retryable: failure !== "mismatch",
  };
}
