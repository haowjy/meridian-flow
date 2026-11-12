/**
 * While the side is closed, main's header names what it would show. Pressing it opens the side.
 * The side keeps following its rule while closed, so the name changes as main does.
 */
import { t } from "@lingui/core/macro";
import { MessageSquare, Pin } from "lucide-react";
import type { OpenDocument } from "@/client/stores";
import { cn } from "@/lib/utils";
import { fileKindIcon } from "../context/context-file-icon";
import { tabChipClass } from "../shell/tab-chip";
import { useSideChatName } from "./SideHeader";
import { useSideItem } from "./SideView";

export function ClosedSideButton({
  projectId,
  document,
  onOpen,
}: {
  projectId: string;
  /** The side's document, when it shows one. */
  document: OpenDocument | null;
  onOpen: () => void;
}) {
  const side = useSideItem();
  const chat = side.item?.kind === "chat" ? side.item : null;
  const chatName = useSideChatName(projectId, chat?.chatId ?? null);
  const name = chat ? chatName : document?.name;
  if (!name) return null;
  const Icon = chat ? MessageSquare : fileKindIcon(name);
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={t`Show ${name} beside`}
      // An inactive tab in main's band. The margin gives back the pill's 2px inset, so the
      // pill and the name sit where they would with no inset.
      className={cn(
        "focus-ring",
        tabChipClass(false),
        "-mx-0.5 max-w-57 min-w-0 shrink gap-1.5 px-2.5 text-xs",
      )}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">{name}</span>
      {side.source === "held" ? <Pin className="size-3 shrink-0" aria-label={t`Held`} /> : null}
    </button>
  );
}
