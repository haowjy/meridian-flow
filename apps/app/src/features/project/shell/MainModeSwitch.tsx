import { t } from "@lingui/core/macro";
import { MessageSquare, PenLine } from "lucide-react";
import { useEffect, useState } from "react";
import { mainTabKey, readMainTabs } from "@/client/project-shell/main-tabs";
import { SegmentedTabs } from "@/components/ui/segmented-tabs";
import { useAccountId } from "../context/account-feature-context";
import { useChatNavigation } from "../routing/chat-navigation";
import { useOpenContextRoute, useProjectRouteCommands } from "../routing/ProjectNavigationContext";
import { useOpenInMain } from "../routing/use-open-document-in-editor";
import { useSideItem } from "../side/SideView";

type MainMode = "write" | "chat";

/**
 * The Write | Chat switch: main's mode, read from main's item (a chat is Chat, anything else is
 * Write) and never stored apart from it. Pressing a mode swaps the panes: main opens what the side
 * holds of that kind, else that lane's selected tab, else the lane's empty page (Recently opened,
 * a new chat). The side then shows what main left, by the slot rule, with no code of its own.
 * The pressed side shows at once, while main's navigation settles.
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
  const accountId = useAccountId();
  const chat = useChatNavigation();
  const open = useOpenContextRoute();
  if (!open) throw new Error("The Write | Chat switch needs a project route");
  const openInMain = useOpenInMain(projectId, open);
  const { showEditorRecents } = useProjectRouteCommands();
  const side = useSideItem();
  const beside = side.item;
  const mode: MainMode = chat.display ? "chat" : "write";
  const [pressed, setPressed] = useState<MainMode | null>(null);
  useEffect(() => {
    if (pressed === mode) setPressed(null);
  }, [pressed, mode]);

  /** Moves main; false when the navigation did not land (refused, superseded, failed). */
  const go = async (next: MainMode): Promise<boolean> => {
    const lane = readMainTabs(accountId, projectId)[next === "chat" ? "chat" : "document"];
    const selected = lane.tabs.find((member) => mainTabKey(member) === lane.selected);
    if (next === "chat") {
      const chatId = beside?.kind === "chat" ? beside.chatId : null;
      if (chatId) await chat.openChat(chatId);
      else if (selected?.kind === "chat") await chat.openChat(selected.chatId);
      else await chat.openNewChat();
      return true;
    }
    const document =
      beside?.kind === "document" && side.document
        ? side.document
        : selected?.kind === "document"
          ? selected.document
          : null;
    if (!document) {
      await showEditorRecents({ replace: false });
      return true;
    }
    return (await openInMain(document)).kind === "applied";
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
        setPressed(next);
        // Main's move holds the thread for a few frames: it starts after the switch has painted.
        // A landed switch lets go once main's item says the same; one that didn't, at once.
        requestAnimationFrame(() =>
          setTimeout(() =>
            go(next).then(
              (moved) => (moved ? onSwitched?.() : setPressed(null)),
              () => setPressed(null),
            ),
          ),
        );
      }}
    />
  );
}
