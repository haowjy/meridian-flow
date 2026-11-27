import type { Work } from "@meridian/contracts/protocol";
import type { ContextRouteRequest } from "@/client/project-shell/project-route";
import { ChatScreen } from "../chat/ChatScreen";
import { MobileKeyboardAware } from "./MobileKeyboardAware";

export type MobileChatHostProps = {
  projectId: string;
  threadId: string | null;
  activeWork: Work | null;
  availableWorks: readonly Work[];
  onOpenContextTarget?: (target: ContextRouteRequest) => void;
};

export function MobileChatHost({
  projectId,
  threadId,
  activeWork,
  availableWorks,
  onOpenContextTarget,
}: MobileChatHostProps) {
  return (
    <MobileKeyboardAware>
      <ChatScreen
        projectId={projectId}
        threadId={threadId}
        activeWork={activeWork}
        availableWorks={availableWorks}
        onOpenContextTarget={onOpenContextTarget}
      />
    </MobileKeyboardAware>
  );
}
