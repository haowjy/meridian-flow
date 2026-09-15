/** App wiring for account-owned creation controllers; destinations only observe and navigate. */
import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useInsertionEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import { isMeridianApiError } from "@/client/api/http-client";
import { listProjectAgents } from "@/client/api/project-agents-api";
import {
  createProject,
  createProjectThread,
  getProject,
  listProjects,
  listProjectThreads,
} from "@/client/api/projects-api";
import { useFirstSendContinuity } from "@/client/first-send-continuity";
import { CreationController } from "@/client/first-send-continuity/creation-controller";
import {
  invalidateProjectThreadData,
  invalidateWorkThreads,
} from "@/client/query/project-invalidation";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { refreshWorksSnapshot } from "@/client/query/works-projection-acquisition";
import { useProjectActions, useThreadActions } from "@/client/stores";
import { threadCreateAgentField, wireAgentSlug } from "@/features/agents";

import { useAccountEpochSignal } from "@/features/project/context/account-feature-context";

const Context = createContext<((projectId: string | null) => CreationController) | null>(null);

export function CreationProvider({ children }: { children: ReactNode }) {
  const accountSignal = useAccountEpochSignal();
  const continuity = useFirstSendContinuity();
  const projectActions = useProjectActions();
  const threadActions = useThreadActions();
  const queryClient = useQueryClient();
  const registry = useMemo(() => {
    const controllers = new Map<string | null, CreationController>();
    return {
      controllers,
      get(projectId: string | null) {
        let controller = controllers.get(projectId);
        if (!controller) {
          controller = new CreationController(projectId, continuity, {
            accountSignal,
            findProject: async (id) =>
              (await listProjects()).some((project) => project.id === id) ? getProject(id) : null,
            createProject: (id, title) => createProject({ id, title }),
            findThread: async (projectId, id) =>
              (await listProjectThreads(projectId)).find((thread) => thread.id === id) ?? null,
            createThread: (attempt) =>
              createProjectThread(attempt.projectId, {
                id: attempt.threadId,
                title: attempt.title,
                workId: attempt.workId,
                ...threadCreateAgentField(attempt.agentSlug),
              }),
            matchesThread: (thread, attempt) =>
              thread.id === attempt.threadId &&
              thread.projectId === attempt.projectId &&
              thread.workId === attempt.workId &&
              thread.userId === continuity.accountId &&
              thread.kind === "primary" &&
              thread.title === attempt.title &&
              thread.deletedAt === null &&
              thread.currentAgent === (wireAgentSlug(attempt.agentSlug) ?? null),
            refusal: (error) =>
              isMeridianApiError(error) &&
              (error.code === "agent_not_found" || error.code === "work_unavailable")
                ? error.code
                : null,
            async refreshChoices(projectId, refusal) {
              if (refusal === "work_unavailable")
                await queryClient.fetchQuery({
                  queryKey: projectQueryKeys.works(projectId),
                  queryFn: () => refreshWorksSnapshot(queryClient, projectId),
                  staleTime: 0,
                });
              else
                await queryClient.fetchQuery({
                  queryKey: projectQueryKeys.agents(projectId),
                  queryFn: async () => (await listProjectAgents(projectId)).agents,
                  staleTime: 0,
                });
            },
            async prepareAdmission(project, thread, attempt, assertAlive) {
              await invalidateProjectThreadData(queryClient, project.id);
              assertAlive();
              if (thread.workId)
                await invalidateWorkThreads(queryClient, project.id, thread.workId);
              assertAlive();
              const catalog = await listProjectThreads(project.id);
              assertAlive();
              const existing = attempt.submission
                ? await continuity.peek({
                    projectId: project.id,
                    threadId: thread.id,
                    submissionId: attempt.submission.submissionId,
                  })
                : null;
              assertAlive();
              queryClient.setQueryData(projectQueryKeys.threads(project.id), catalog);
              projectActions.ensureProject(project);
              threadActions.ensureThread(thread);
              const optimisticUserTurnId = attempt.submission
                ? (existing?.optimisticUserTurnId ??
                  threadActions.appendUserTurn(thread.id, attempt.submission.text).id)
                : undefined;
              return {
                optimisticUserTurnId,
                cancel() {
                  if (!existing && optimisticUserTurnId)
                    threadActions.removeOptimisticUserTurn(thread.id, optimisticUserTurnId);
                },
              };
            },
          });
          controllers.set(projectId, controller);
        }
        return controller;
      },
    };
  }, [accountSignal, continuity, projectActions, threadActions, queryClient]);
  useInsertionEffect(
    () => () => {
      for (const controller of registry.controllers.values()) controller.dispose();
    },
    [registry],
  );
  return <Context.Provider value={registry.get}>{children}</Context.Provider>;
}

export function useCreation(projectId: string | null) {
  const get = useContext(Context);
  if (!get) throw new Error("CreationProvider is required");
  const controller = get(projectId);
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  useEffect(() => {
    void controller.reload();
  }, [controller]);
  return { controller, state };
}
