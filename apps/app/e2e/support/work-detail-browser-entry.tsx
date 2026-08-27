/** Browser entry that mounts WorkPaneController with deterministic component-fixture adapters. */
import { createRoot } from "react-dom/client";
import { WorkPaneController } from "../../src/features/project/WorkPaneController";
import "../../src/styles/globals.css";

const fixture = window.__WORK_DETAIL_FIXTURE__;
const root = document.getElementById("root");
if (!root) throw new Error("Missing browser fixture root");
createRoot(root).render(
  <div className="flex h-svh w-full">
    <WorkPaneController
      projectId={fixture.work.projectId}
      sidebarToggle={{ open: true, label: "Open sidebar", onExpand: () => undefined }}
      chatToggle={{ open: true, label: "Open chat", onExpand: () => undefined }}
      routeWork={{ status: "present", work: fixture.work }}
      routeCommands={{
        openHome: async () => undefined,
        openChat: async () => undefined,
        openDockThread: async () => undefined,
        openWork: async () => undefined,
        workHref: () => "?screen=work",
        closeWork: async () => undefined,
        openWorkContext: async () => undefined,
      }}
      onOpenThread={() => undefined}
    />
  </div>,
);
