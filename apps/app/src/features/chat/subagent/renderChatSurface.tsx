/** Shared component-test shell for chat surfaces with their real navigation context. */
import type { ReactNode } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ChatThreadNavigationProvider } from "../ChatThreadNavigation";

export function renderChatSurface(children: ReactNode, onOpenThread: (threadId: string) => void) {
  return (
    <TooltipProvider>
      <ChatThreadNavigationProvider onOpenThread={onOpenThread}>
        {children}
      </ChatThreadNavigationProvider>
    </TooltipProvider>
  );
}
