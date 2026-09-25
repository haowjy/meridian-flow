/** WorkPaneController — desktop chrome for the dedicated Work destination. */
import { Trans } from "@lingui/react/macro";

import { PaneTitle } from "./PaneTitle";
import type { ProjectRouteCommands, RouteWorkResolution } from "./routing/project-route";
import { PaneHeader, type PaneHeaderRailToggle } from "./shell/PaneHeader";
import { WorkScreen } from "./work/WorkScreen";

export type WorkPaneControllerProps = {
  projectId: string;
  sidebarToggle: PaneHeaderRailToggle;
  chatToggle: PaneHeaderRailToggle;
  routeWork: RouteWorkResolution;
  routeCommands: ProjectRouteCommands;
};

export function WorkPaneController({
  projectId,
  sidebarToggle,
  chatToggle,
  routeWork,
  routeCommands,
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
        <WorkScreen projectId={projectId} routeWork={routeWork} routeCommands={routeCommands} />
      </div>
    </main>
  );
}
