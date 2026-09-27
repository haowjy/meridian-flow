/** Browser entry that mounts WorkPaneController with deterministic component-fixture adapters. */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import {
  type ChatNavigation,
  ChatNavigationProvider,
} from "../../src/features/project/routing/chat-navigation";
import { WorkDetailScreen } from "../../src/features/project/work/WorkDetailScreen";
import "../../src/styles/globals.css";

const fixture = window.__WORK_DETAIL_FIXTURE__;
const root = document.getElementById("root");
if (!root) throw new Error("Missing browser fixture root");
const noop = async () => undefined;
const unregister = () => () => undefined;
const queryClient = new QueryClient();
const chatNavigation: ChatNavigation = {
  currentThreadId: null,
  recoveringFirstSend: false,
  newChatFocusRequestId: null,
  newChatWorkId: undefined,
  consumeNewChatFocusRequest: () => undefined,
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
  <QueryClientProvider client={queryClient}>
    <ChatNavigationProvider value={chatNavigation}>
      <div className="flex h-svh w-full">
        <WorkDetailScreen
          projectId={fixture.work.projectId}
          work={fixture.work}
          routeCommands={{
            openWork: async () => undefined,
            workHref: () => "?screen=work",
            closeWork: async () => undefined,
            openWorkContext: async () => undefined,
          }}
          catalogWorks={[fixture.work]}
        />
      </div>
    </ChatNavigationProvider>
  </QueryClientProvider>,
);
