// @ts-nocheck
/**
 * MobileResultsView — full-screen Results surface for the phone shell.
 *
 * Lists the workbench's promoted artifacts by reusing the shared
 * `ResultsRailBody` (single source of result-listing logic) and opens rows in
 * `MobileResultViewerOverlay`, which owns phone full-screen chrome. Results are
 * workbench-scoped, not per-thread, so this view is identical regardless of
 * which chat the user arrived from. It is reached from the chat top bar's
 * `?results=` route param — it has no drawer nav item and no Files-root row.
 */
import { useState } from "react";

import type { WorkbenchResultItem } from "@/client/api/workbench-results-api";
import { ResultsRailBody, useResultsRailModel } from "../shell/ResultsRailSection";
import { MobileResultViewerOverlay } from "./MobileResultViewerOverlay";

export function MobileResultsView({ workbenchId }: { workbenchId: string }) {
  const [openResult, setOpenResult] = useState<WorkbenchResultItem | null>(null);
  const results = useResultsRailModel(workbenchId);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* bg-sidebar matches the rail chrome the body was designed against,
            so its rows/hover states read the same here. The top bar already
            titles this screen "Results". */}
        <div className="min-h-full bg-sidebar px-2 py-3">
          <ResultsRailBody workbenchId={workbenchId} model={results} onOpenResult={setOpenResult} />
        </div>
      </div>
      {openResult ? (
        <MobileResultViewerOverlay
          workbenchId={workbenchId}
          result={openResult}
          onClose={() => setOpenResult(null)}
        />
      ) : null}
    </div>
  );
}
