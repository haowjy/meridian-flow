/** React effect shell for the project-entry bootstrap authority. */

import type { QueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { WorkingSetHydrationPlan } from "@/client/working-set";
import {
  type ContextProjectAuthority,
  type ContextProjectPhase,
  cancelContextProjectAttempt,
  contextProjectPhase,
  INITIAL_CONTEXT_PROJECT_AUTHORITY,
  settleContextProjectBootstrap,
  updateContextProjectReadiness,
} from "./context-project-phase";
import type { EditorWorkScope } from "./editor-work-scope";
import {
  type ContextDeskReconciliationScope,
  contextDeskReconciliation,
  seedWorkingSetTabs,
  validateContextDeskTabs,
} from "./working-set-tab-seeding";

export function useContextProjectAuthority({
  projectId,
  deskHydrated,
  editorScope,
  workingSetHydration,
  queryClient,
}: {
  projectId: string;
  deskHydrated: boolean;
  editorScope: EditorWorkScope;
  workingSetHydration: WorkingSetHydrationPlan;
  queryClient: QueryClient;
}): ContextProjectPhase {
  const [authority, setAuthority] = useState<ContextProjectAuthority>(
    INITIAL_CONTEXT_PROJECT_AUTHORITY,
  );
  const authorityRef = useRef(authority);
  const rawBootstrapRef = useRef<Promise<void> | null>(null);
  const rawOperationRef = useRef(0);
  const mountedRef = useRef(true);
  const editorWorkId = editorScope.status === "empty" ? null : editorScope.workId;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const updateAuthority = (next: ContextProjectAuthority) => {
      authorityRef.current = next;
      if (mountedRef.current) setAuthority(next);
    };
    const transition = updateContextProjectReadiness(
      authorityRef.current,
      deskHydrated,
      editorScope,
    );
    updateAuthority(transition.authority);
    if (!transition.effect) return;
    const { attempt, raw } = transition.effect;
    if (raw === "start") {
      const operation = rawOperationRef.current + 1;
      rawOperationRef.current = operation;
      const scope: ContextDeskReconciliationScope = {
        projectId,
        editorWorkId: attempt.workId,
        generation: operation,
      };
      const isLiveScope = (candidate: ContextDeskReconciliationScope) =>
        mountedRef.current && rawOperationRef.current === candidate.generation;
      const reconciliation = contextDeskReconciliation(workingSetHydration);
      const bootstrap =
        reconciliation === "server-replace" && workingSetHydration.status === "server"
          ? seedWorkingSetTabs({
              queryClient,
              routes: workingSetHydration.row.recentRoutes,
              scope,
              isLiveScope,
            })
          : validateContextDeskTabs({ queryClient, scope, isLiveScope });
      rawBootstrapRef.current = bootstrap.then(
        () => undefined,
        () => undefined,
      );
    }
    const bootstrap = rawBootstrapRef.current;
    if (!bootstrap) throw new Error("Context bootstrap adoption requires the raw operation");
    void bootstrap.then(() => {
      if (!mountedRef.current) return;
      updateAuthority(settleContextProjectBootstrap(authorityRef.current, attempt.token));
    });
    return () => {
      updateAuthority(cancelContextProjectAttempt(authorityRef.current, attempt.token));
    };
  }, [deskHydrated, editorScope.status, editorWorkId, projectId, queryClient, workingSetHydration]);

  return contextProjectPhase(authority);
}
