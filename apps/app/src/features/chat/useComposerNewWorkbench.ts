// @ts-nocheck
import { t } from "@lingui/core/macro";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import {
  announce,
  useThreadActions,
  useWorkbenchActions,
  useWorkbenchStore,
} from "@/client/stores";
import { startWorkbenchFromComposer } from "@/lib/optimistic-workbench";

export type UseComposerNewWorkbenchOptions = {
  /** Announce when a new workbench is started (Home uses this). */
  announceStarted?: boolean;
};

/**
 * Home composer submit: optimistic workbench + thread + navigate to workbench view.
 */
export function useComposerNewWorkbench(options: UseComposerNewWorkbenchOptions = {}) {
  const navigate = useNavigate();
  const workbenchActions = useWorkbenchActions();
  const threadActions = useThreadActions();
  const now = useWorkbenchStore((s) => s.now);
  const { announceStarted = false } = options;

  return useCallback(
    (text: string, currentAgent?: string) => {
      startWorkbenchFromComposer({
        text,
        currentAgent,
        workbenchActions,
        threadActions,
        navigate,
        now,
      });
      if (announceStarted) {
        announce(t`New workbench started`);
      }
    },
    [announceStarted, navigate, now, workbenchActions, threadActions],
  );
}
