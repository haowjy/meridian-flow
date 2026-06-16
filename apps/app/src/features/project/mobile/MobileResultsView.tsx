/**
 * MobileResultsView — full-screen Results surface for the phone shell.
 *
 * Lists the project's promoted artifacts by reusing the shared
 * `ResultsRailBody` (single source of result-listing logic) and opens rows in
 * `MobileResultViewerOverlay`, which owns phone full-screen chrome. Results are
 * project-scoped, not per-thread, so this view is identical regardless of
 * which chat the user arrived from. It is reached from the chat top bar's
 * `?results=` route param — it has no drawer nav item and no Files-root row.
 */
import { useState } from "react";

import type { ProjectResultItem } from "@/client/api/project-results-api";
import { ResultsRailBody, useResultsRailModel } from "../shell/ResultsRailSection";
import { MobileResultViewerOverlay } from "./MobileResultViewerOverlay";

export function MobileResultsView({ projectId }: { projectId: string }) {
  const [openResult, setOpenResult] = useState<ProjectResultItem | null>(null);
  const results = useResultsRailModel(projectId);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* bg-sidebar matches the rail chrome the body was designed against,
            so its rows/hover states read the same here. The top bar already
            titles this screen "Results". */}
        <div className="min-h-full bg-sidebar px-2 py-3">
          <ResultsRailBody projectId={projectId} model={results} onOpenResult={setOpenResult} />
        </div>
      </div>
      {openResult ? (
        <MobileResultViewerOverlay
          projectId={projectId}
          result={openResult}
          onClose={() => setOpenResult(null)}
        />
      ) : null}
    </div>
  );
}
