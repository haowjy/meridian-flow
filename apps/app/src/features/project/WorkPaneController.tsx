/** WorkPaneController — desktop chrome for the dedicated Work destination. */
import { Trans } from "@lingui/react/macro";

import { PaneTitle } from "./PaneTitle";
import { PaneHeader, type PaneHeaderRailToggle } from "./shell/PaneHeader";
import { WorkScreen } from "./work/WorkScreen";

export type WorkPaneControllerProps = {
  projectId: string;
  sidebarToggle: PaneHeaderRailToggle;
  chatToggle: PaneHeaderRailToggle;
};

export function WorkPaneController({
  projectId,
  sidebarToggle,
  chatToggle,
}: WorkPaneControllerProps) {
  return (
    <main className="main-pane flex min-h-0 flex-1 flex-col">
      <PaneHeader
        title={
          <PaneTitle>
            <Trans>Work</Trans>
          </PaneTitle>
        }
        left={sidebarToggle}
        right={chatToggle}
      />
      <div className="page-sheet">
        <WorkScreen projectId={projectId} />
      </div>
    </main>
  );
}
