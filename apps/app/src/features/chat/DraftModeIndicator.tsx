/** Quiet thread-level status for a Work whose AI edits land as drafts. */
import { Trans } from "@lingui/react/macro";
import type { AiWriteMode } from "@meridian/contracts/works";
import { ChatColumn } from "./ChatColumn";

export function DraftModeIndicator({ mode }: { mode: AiWriteMode | null }) {
  if (mode !== "draft") return null;

  return (
    <div className="border-border-subtle border-b bg-dock-surface" data-thread-write-mode="draft">
      <ChatColumn className="flex min-h-7 items-center gap-1.5 overflow-hidden text-caption">
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-jade-text" />
        <span className="shrink-0 font-medium text-prose-foreground">
          <Trans>Draft mode</Trans>
        </span>
        <span aria-hidden className="shrink-0 text-ink-subtle">
          ·
        </span>
        <span className="truncate text-ink-muted">
          <Trans>AI changes wait for your review</Trans>
        </span>
      </ChatColumn>
    </div>
  );
}
