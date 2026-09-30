/**
 * Header doors to the chat index. They sit in the pane's existing 40px band,
 * right after the sidebar toggle, where the Editor keeps its Recently opened
 * door, so they read as chrome rather than page content.
 *
 * - `ChatIndexChip` — the centered Chat pane, which rises out of the band like
 *   the document tab strip; it wears the same tab-chip grammar as History.
 * - The remembered chat waits beside it as a `ReturnTabChip`.
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
