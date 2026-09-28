/**
 * WorkPaneController — desktop chrome for the dedicated Work destination.
 *
 * The band follows the Chat pane's grammar: an All Work door chip, then the
 * open Work's name as the active tab the page rises into (renamed in place),
 * and the Work's `…` actions at the far right.
 */

import type { Work } from "@meridian/contracts/protocol";
import type { ProjectRouteCommands, RouteWorkResolution } from "./routing/project-route";
import { PaneHeader, type PaneHeaderRailToggle } from "./shell/PaneHeader";
import { useWorkChrome } from "./work/useWorkChrome";
import { useWorkDeletion } from "./work/useWorkDeletion";
import { WorkScreen } from "./work/WorkScreen";

export type WorkPaneControllerProps = {
  projectId: string;
  sidebarToggle: PaneHeaderRailToggle;
  chatToggle: PaneHeaderRailToggle;
  routeWork: RouteWorkResolution;
  rememberedWork: Work | null;
  routeCommands: ProjectRouteCommands;
};

export function WorkPaneController({
  projectId,
  sidebarToggle,
  chatToggle,
  routeWork,
  rememberedWork,
  routeCommands,
}: WorkPaneControllerProps) {
  const deletion = useWorkDeletion(projectId, routeWork, routeCommands);
  const chrome = useWorkChrome(
    projectId,
    routeWork,
    rememberedWork,
    routeCommands,
    deletion.remove,
    "tab",
  );
  return (
    <main className="main-pane flex min-h-0 flex-1 flex-col">
      <PaneHeader
        leading={chrome.door}
        title={chrome.title}
        actions={chrome.actions}
        left={sidebarToggle}
        right={chatToggle}
      />
      <div className="page-sheet">
        <WorkScreen
          projectId={projectId}
          routeWork={routeWork}
          routeCommands={routeCommands}
          deletion={deletion}
        />
      </div>
    </main>
  );
}
