/** React effect shell for the project-entry bootstrap authority. */

import { useEffect, useRef, useState } from "react";
import {
  type ContextDeskValidationScope,
  validateContextDeskTabs,
} from "./browser-editor-tab-validation";
import { useOptionalAccountResourceReplica } from "./context/account-feature-context";
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

export function useContextProjectAuthority({
  projectId,
  deskHydrated,
  editorScope,
}: {
  projectId: string;
  deskHydrated: boolean;
  editorScope: EditorWorkScope;
}): ContextProjectPhase {
  const [authority, setAuthority] = useState<ContextProjectAuthority>(
    INITIAL_CONTEXT_PROJECT_AUTHORITY,
  );
  const resources = useOptionalAccountResourceReplica();
  const authorityRef = useRef(authority);
  const rawBootstrapRef = useRef<Promise<void> | null>(null);
  const rawOperationRef = useRef(0);
  const mountedRef = useRef(true);
  const editorWorkId = editorScope.workId;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!resources) return;
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
      const scope: ContextDeskValidationScope = {
        projectId,
        generation: operation,
      };
      const isLiveScope = (candidate: ContextDeskValidationScope) =>
        mountedRef.current && rawOperationRef.current === candidate.generation;
      const bootstrap = validateContextDeskTabs({ resources, scope, isLiveScope });
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
  }, [deskHydrated, editorScope.status, editorWorkId, projectId, resources]);

  return contextProjectPhase(authority);
}
