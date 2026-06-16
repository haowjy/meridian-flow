import { t } from "@lingui/core/macro";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { announce, useProjectActions, useProjectStore, useThreadActions } from "@/client/stores";
import { startProjectFromComposer } from "@/lib/optimistic-project";

export type UseComposerNewProjectOptions = {
  /** Announce when a new project is started (Home uses this). */
  announceStarted?: boolean;
};

/**
 * Home composer submit: optimistic project + thread + navigate to project view.
 */
export function useComposerNewProject(options: UseComposerNewProjectOptions = {}) {
  const navigate = useNavigate();
  const projectActions = useProjectActions();
  const threadActions = useThreadActions();
  const now = useProjectStore((s) => s.now);
  const { announceStarted = false } = options;

  return useCallback(
    (text: string, currentAgent?: string) => {
      startProjectFromComposer({
        text,
        currentAgent,
        projectActions,
        threadActions,
        navigate,
        now,
      });
      if (announceStarted) {
        announce(t`New project started`);
      }
    },
    [announceStarted, navigate, now, projectActions, threadActions],
  );
}
