/** Browser entry that mounts the shipped Work detail component with deterministic adapters. */
import { createRoot } from "react-dom/client";
import { WorkDetailScreen } from "../../src/features/project/work/WorkDetailScreen";
import "../../src/styles/globals.css";

const fixture = window.__WORK_DETAIL_FIXTURE__;
const root = document.getElementById("root");
if (!root) throw new Error("Missing browser fixture root");
createRoot(root).render(
  <WorkDetailScreen
    projectId={fixture.work.projectId}
    work={fixture.work}
    routeWork={{ status: "absent" }}
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
  />,
);
