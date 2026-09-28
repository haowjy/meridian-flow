/**
 * Header doors to the chat index. They sit in the pane's existing 40px band,
 * right after the sidebar toggle, where the Editor keeps its Recently opened
 * door, so they read as chrome rather than page content.
 *
 * - `ChatIndexChip` — the centered Chat pane, which rises out of the band like
 *   the document tab strip; it wears the same tab-chip grammar as History.
 * - `CurrentChatChip` — on the center index, the remembered chat as an
 *   inactive tab: the way back, like an open document tab beside Recents.
 *
 * The dock has no index: its switcher lists the chats.
 */
import { t } from "@lingui/core/macro";
import { MessagesSquare } from "lucide-react";
import { IndexTabChip } from "../shell/IndexTabChip";

export function ChatIndexChip({ active, onClick }: { active: boolean; onClick?: () => void }) {
  return (
    <IndexTabChip icon={MessagesSquare} label={t`All chats`} active={active} onClick={onClick} />
  );
}

export function CurrentChatChip({ title, onClick }: { title: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={t`Back to ${title}`}
      className="focus-ring tab-chip-inactive relative flex min-w-0 max-w-64 items-center self-stretch px-3 text-muted-foreground hover:text-foreground [--tab-chip-surface:var(--color-background)]"
    >
      <span className="truncate px-1 text-sm font-medium">{title}</span>
    </button>
  );
}
