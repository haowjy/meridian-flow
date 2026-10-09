/**
 * The dock's Results row: a promoted artifact (plot, PDF, file) shown in the
 * document slot the Chat screen's rail uses for documents, in place of the
 * dialog. A result is read by id through a signed URL, so it has the viewers
 * but no editor, tab or title menu; the header names it and closes the slot.
 */

import { PaneTitle } from "../PaneTitle";
import { displayName, pickIconForMime } from "../shell/ResultsRailSection";
import { ResultViewerContent } from "../shell/ResultViewerOverlay";
import type { DockResult } from "./dock-view-store";

export function DockResultView({ projectId, result }: { projectId: string; result: DockResult }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ResultViewerContent projectId={projectId} result={result} bare />
    </div>
  );
}

export function DockResultTitle({ result }: { result: DockResult }) {
  const { Icon } = pickIconForMime(result.mimeType);
  return (
    <div
      className="flex min-w-0 items-center gap-[var(--chat-space-inline)] px-1"
      title={result.workspacePath}
    >
      <Icon className="size-4 shrink-0 text-ink-subtle" aria-hidden />
      <PaneTitle className="min-w-0 flex-1 px-0">{displayName(result)}</PaneTitle>
    </div>
  );
}
