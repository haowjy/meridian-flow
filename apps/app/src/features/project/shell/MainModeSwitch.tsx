import { t } from "@lingui/core/macro";
import { MessageSquare, PenLine } from "lucide-react";
import { useRef, useState } from "react";
import { useLiveTabs } from "@/client/project-shell/live-tabs";
import { mainTabKey } from "@/client/project-shell/main-tabs";
import { SegmentedTabs } from "@/components/ui/segmented-tabs";
import { useChatNavigation } from "../routing/chat-navigation";
import { useOpenContextRoute, useProjectRouteCommands } from "../routing/ProjectNavigationContext";
import type { NavigationSettlement } from "../routing/project-navigation";
import { useOpenInMain } from "../routing/use-open-document-in-editor";
import { useSideItem } from "../side/SideView";

type MainMode = "write" | "chat";

/**
 * The Write | Chat switch: main's mode, read from main's item (a chat is Chat, anything else is
 * Write) and never stored apart from it. Pressing a mode swaps the panes: main opens what the side
 * holds of that kind, else that lane's selected tab, else the lane's empty page (Recently opened,
 * a new chat). The side then shows what main left, by the slot rule, and the grid glides the
 * hosts (`layout/SlotGrid.tsx`), with no code of its own. The pressed side shows at once, while
 * main's navigation settles.
 */
export function MainModeSwitch({
  projectId,
  onSwitched,
  className,
}: {
  projectId: string;
  /** After main has moved (the phone drawer closes). */
  onSwitched?: () => void;
  className?: string;
}) {
  const chat = useChatNavigation();
  const open = useOpenContextRoute();
  if (!open) throw new Error("The Write | Chat switch needs a project route");
  const openInMain = useOpenInMain(projectId, open);
  const { showEditorRecents } = useProjectRouteCommands();
  const { lanes } = useLiveTabs(projectId);
  const side = useSideItem();
  const beside = side.item;
  const mode: MainMode = chat.display ? "chat" : "write";
  // The mode last pressed, shown until its navigation settles (whatever the settlement); a newer
  // press takes over.
  const [pressed, setPressed] = useState<MainMode | null>(null);
  const latestPress = useRef(0);

  const go = (next: MainMode): Promise<NavigationSettlement> => {
    const lane = lanes[next === "chat" ? "chat" : "document"];
    const selected = lane.tabs.find((member) => mainTabKey(member) === lane.selected);
    if (next === "chat") {
      const chatId = beside?.kind === "chat" ? beside.chatId : null;
      if (chatId) return chat.openChat(chatId);
      if (selected?.kind === "chat") return chat.openChat(selected.chatId);
      return chat.openNewChat();
    }
    const document =
      beside?.kind === "document" && side.document
        ? side.document
        : selected?.kind === "document"
          ? selected.document
          : null;
    return document ? openInMain(document) : showEditorRecents({ replace: false });
  };

  return (
    <SegmentedTabs
      label={t`Write or chat`}
      fill
      className={className}
      value={pressed ?? mode}
      options={[
        { value: "write", label: t`Write`, icon: PenLine },
        { value: "chat", label: t`Chat`, icon: MessageSquare },
      ]}
      onChange={(next) => {
        const press = ++latestPress.current;
        setPressed(next);
        // Main's move holds the thread for a few frames: it starts after the switch has painted.
        requestAnimationFrame(() =>
          setTimeout(() => {
            go(next)
              .then((settled) => {
                if (settled.kind === "applied") onSwitched?.();
              })
              .finally(() => {
                if (latestPress.current === press) setPressed(null);
              });
          }),
        );
      }}
    />
  );
}
