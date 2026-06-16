import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useEffect } from "react";

import { deleteProject } from "@/client/api/projects-api";
import { announce, announceError, useProjectActions, useProjectStore } from "@/client/stores";
import { displayProjectTitle } from "@/lib/project-title";

/** Undo window for soft-deleted projects (ms). */
const UNDO_WINDOW_MS = 30_000;

/**
 * The "Project deleted — Undo" pill above the sidebar footer. Owns the 30s
 * timer that finalizes the delete via API. The store keeps only the captured
 * project; this component drives the clock.
 */
export function SidebarUndoPill() {
  const actions = useProjectActions();
  const pending = useProjectStore((s) => s.pendingDelete);
  const pendingId = pending?.project.id;

  useEffect(() => {
    if (!pendingId) return;
    const projectId = pendingId;
    let cancelled = false;

    const handle = window.setTimeout(() => {
      void (async () => {
        try {
          await deleteProject(projectId);
          if (cancelled) return;
          actions.finalizeSoftDelete(projectId);
        } catch {
          if (cancelled) return;
          actions.undoSoftDelete(projectId);
          announceError(t`Could not delete project. It was restored.`);
        }
      })();
    }, UNDO_WINDOW_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [actions, pendingId]);

  if (!pending) return null;

  const title = displayProjectTitle(pending.project.title);
  const undoLabel = t`Undo deletion of ${title}`;

  function handleUndo() {
    if (!pending) return;
    actions.undoSoftDelete(pending.project.id);
    announce(t`Deletion undone`);
  }

  return (
    <div
      key={pending.project.id}
      role="status"
      aria-live="polite"
      className="surface-card relative mx-2 mb-1 flex items-center gap-2.5 overflow-hidden rounded-[10px] px-3 py-2 text-[12.5px] shadow-card"
    >
      <span className="flex-1 truncate text-foreground">
        <Trans>Project deleted</Trans>
      </span>
      <button
        type="button"
        aria-label={undoLabel}
        onClick={handleUndo}
        className="focus-ring rounded-md px-1.5 py-0.5 text-[12.5px] font-medium text-primary transition-colors hover:bg-status-done-bg"
      >
        <Trans>Undo</Trans>
      </button>

      <span
        aria-hidden
        className="absolute right-0 bottom-0 left-0 h-[2px] origin-left bg-countdown-track motion-safe:animate-[countdown-drain_30s_linear_forwards]"
      />
    </div>
  );
}
