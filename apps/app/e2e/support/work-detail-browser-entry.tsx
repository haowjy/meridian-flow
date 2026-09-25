/** Browser entry that mounts WorkPaneController with deterministic component-fixture adapters. */
import { createRoot } from "react-dom/client";
import {
  type ChatNavigation,
  ChatNavigationProvider,
} from "../../src/features/project/routing/chat-navigation";
import { WorkPaneController } from "../../src/features/project/WorkPaneController";
import "../../src/styles/globals.css";

const fixture = window.__WORK_DETAIL_FIXTURE__;
const root = document.getElementById("root");
if (!root) throw new Error("Missing browser fixture root");
const noop = async () => undefined;
const unregister = () => () => undefined;
const chatNavigation: ChatNavigation = {
  currentThreadId: null,
  recoveringFirstSend: false,
  openChat: noop,
  openNewChat: noop,
  openChatIndex: noop,
  showChatScreen: noop,
  acceptCreatedChat: () => undefined,
  forgetChat: () => undefined,
  registerDockReveal: unregister,
  registerNewChatFocus: unregister,
};
createRoot(root).render(
  <ChatNavigationProvider value={chatNavigation}>
    <div className="flex h-svh w-full">
      <WorkPaneController
        projectId={fixture.work.projectId}
        sidebarToggle={{ open: true, label: "Open sidebar", onExpand: () => undefined }}
        chatToggle={{ open: true, label: "Open chat", onExpand: () => undefined }}
        routeWork={{ status: "present", work: fixture.work }}
        routeCommands={{
          openWork: async () => undefined,
          workHref: () => "?screen=work",
          closeWork: async () => undefined,
          openWorkContext: async () => undefined,
        }}
        onOpenThread={() => undefined}
      />
    </div>
  </ChatNavigationProvider>,
);
