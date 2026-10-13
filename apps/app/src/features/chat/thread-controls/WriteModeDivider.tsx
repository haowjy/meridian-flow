/**
 * The write-mode divider: where the writer switched how the AI writes.
 *
 * A switch is a turn, so it keeps its place on reload. It reuses the compaction
 * divider's mark and rule and has no actions: the mode already changed. The
 * queued row that becomes this divider is `QueuedControlRows`.
 */
import { t } from "@lingui/core/macro";
import type { Turn } from "@meridian/contracts/protocol";
import { DividerMark, DividerRule } from "../compaction/CompactionDivider";
import { readWriteModeSwitch } from "./write-mode-model";

export function WriteModeDivider({ turn }: { turn: Turn }) {
  const facts = readWriteModeSwitch(turn);
  if (!facts) return null;
  const label = facts.mode === "draft" ? t`Switched to draft mode` : t`Switched to auto-apply`;
  return (
    <section
      aria-label={label}
      data-write-mode-divider
      data-write-mode={facts.mode}
      className="flex min-w-0 items-center gap-[var(--chat-space-block)] py-[var(--chat-space-block)]"
    >
      <span className="flex min-w-0 items-center gap-[var(--chat-space-block)]">
        <DividerMark state="complete" loud={false} />
        <span className="min-w-0 truncate text-meta font-medium text-ink-muted">{label}</span>
      </span>
      <DividerRule />
    </section>
  );
}
