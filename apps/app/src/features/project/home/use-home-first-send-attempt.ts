/** Home-owned stable-ID thread creation, reconciliation, and route handoff. */
import type { Thread, ThreadListItem } from "@meridian/contracts/protocol";
import { useCallback, useRef, useState } from "react";
import { HttpResponseError, isMeridianApiError } from "@/client/api/http-client";
import { createProjectThread, listProjectThreads } from "@/client/api/projects-api";
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
    (envelope.work.source === "current_default" || thread.workId === envelope.work.workId)
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
  const attemptRef = useRef<HomeFirstSendEnvelope | null>(null);
  const singleFlightRef = useRef(false);
  const [attempt, setAttempt] = useState<HomeFirstSendEnvelope | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);

  const publish = useCallback((next: HomeFirstSendEnvelope) => {
    attemptRef.current = next;
    setAttempt(next);
  }, []);

  const route = useCallback(
    async (envelope: HomeFirstSendEnvelope, newerDraft = "") => {
      const thread = envelope.canonicalThread;
      if (!thread) return false;
      const routing = { ...envelope, phase: "routing" as const };
      publish(routing);
      if (newerDraft && newerDraft !== envelope.text) {
        actions.preserveFirstSendRouteDraft(thread.id, newerDraft);
      }
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
    [actions, onSelectThread, publish],
  );

  const prepareCanonical = useCallback(
    async (envelope: HomeFirstSendEnvelope, thread: Thread, newerDraft = "") => {
      if (!matchesEnvelope(thread, envelope)) {
        publish({ ...envelope, phase: "failed_create" });
        setFailure("mismatch");
        return false;
      }
      const canonical = { ...envelope, canonicalThread: thread, phase: "routing" as const };
      actions.ensureThread(thread);
      const optimistic = actions.appendUserTurn(thread.id, envelope.text);
      actions.stageFirstSend({
        threadId: thread.id,
        text: envelope.text,
        optimisticUserTurnId: optimistic.id,
        draftAfterRoute: newerDraft && newerDraft !== envelope.text ? newerDraft : undefined,
      });
      publish(canonical);
      return route(canonical, newerDraft);
    },
    [actions, publish, route],
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

  const create = useCallback(
    async (envelope: HomeFirstSendEnvelope, newerDraft = "") => {
      const request = {
        id: envelope.threadId,
        title: envelope.title,
        ...(envelope.work.source === "writer" ? { workId: envelope.work.workId } : {}),
        ...threadCreateAgentField(envelope.agentSlug),
      };
      try {
        return await prepareCanonical(envelope, await createThread(projectId, request), newerDraft);
      } catch (error) {
        if (isAuthoritativeRefusal(error)) {
          publish({ ...envelope, phase: "failed_create" });
          setFailure("create");
          return false;
        }
        const reconciled = await reconcile(envelope);
        if (reconciled) return prepareCanonical(envelope, reconciled, newerDraft);
        if (reconciled === null) {
          try {
            return await prepareCanonical(
              envelope,
              await createThread(projectId, request),
              newerDraft,
            );
          } catch (retryError) {
            if (!isAuthoritativeRefusal(retryError)) {
              const afterRetry = await reconcile(envelope);
              if (afterRetry) return prepareCanonical(envelope, afterRetry, newerDraft);
            }
          }
        }
        publish({ ...envelope, phase: "failed_create" });
        setFailure("create");
        return false;
      }
    },
    [createThread, prepareCanonical, projectId, publish, reconcile],
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
    (text: string, context: { work: HomeWorkSelection; agentSlug: string }) =>
      run(async () => {
        if (attemptRef.current) return false;
        const envelope: HomeFirstSendEnvelope = {
          threadId: makeId(),
          projectId,
          text,
          title: deriveTitleFromMessage(text),
          work: context.work,
          agentSlug: context.agentSlug,
          phase: "creating",
          canonicalThread: null,
        };
        publish(envelope);
        setFailure(null);
        return create(envelope);
      }),
    [create, makeId, projectId, publish, run],
  );

  const retry = useCallback(
    (currentDraft = "") =>
      run(async () => {
        const envelope = attemptRef.current;
        if (!envelope) return false;
        setFailure(null);
        return envelope.canonicalThread
          ? route(envelope, currentDraft)
          : create({ ...envelope, phase: "creating" }, currentDraft);
      }),
    [create, route, run],
  );

  return { attempt, busy, failure, submit, retry, contextLocked: attempt !== null };
}
