/**
 * While the side is closed, main's header names what it would show. Pressing it opens the side.
 * The side keeps following its rule while closed, so the name changes as main does.
 */
import { t } from "@lingui/core/macro";
import { MessageSquare, Pin } from "lucide-react";
import type { ContextTab } from "@/client/stores";
import { fileKindIcon } from "../context/context-file-icon";
import { useMainItem } from "../views";
import { useSideChatName } from "./SideHeader";
import { useSideItem } from "./SideView";

export function ClosedSideButton({
  projectId,
  tab,
  onOpen,
}: {
  projectId: string;
  /** The side's document, when it shows one. */
  tab: ContextTab | null;
  onOpen: () => void;
}) {
  const side = useSideItem();
  const mainName = useMainItem().document.tab?.name ?? null;
  const chat = side.item?.kind === "chat" ? side.item : null;
  const chatName = useSideChatName(projectId, chat?.chatId ?? null, mainName);
  const name = chat ? chatName : tab?.name;
  if (!name) return null;
  const Icon = chat ? MessageSquare : fileKindIcon(name);
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={t`Show ${name} beside`}
      className="focus-ring flex h-8 max-w-56 min-w-0 shrink items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-ink-fill hover:text-foreground"
    >
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">{name}</span>
      {side.source === "held" ? <Pin className="size-3 shrink-0" aria-label={t`Held`} /> : null}
    </button>
  );
}
