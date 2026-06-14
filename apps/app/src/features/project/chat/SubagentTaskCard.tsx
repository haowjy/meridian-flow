// @ts-nocheck
/**
 * SubagentTaskCard — warm summary strip for a subagent thread nested under the
 * active project conversation. The card is presentational and receives thread
 * metadata from the project chat panel.
 */
import { Trans } from "@lingui/react/macro";
import type { Thread } from "@meridian/contracts/protocol";
import { Plus } from "lucide-react";

export type SubagentTaskCardProps = {
  subagent: Thread;
};

/**
 * Task-assignment card shown above the subagent conversation. Reads the
 * subagent's first working-state goal when available, otherwise falls back to
 * a placeholder so the layout still demonstrates the structure.
 */
export function SubagentTaskCard({ subagent }: SubagentTaskCardProps) {
  const goal = subagent.workingState?.goals?.[0] ?? null;
  const description =
    goal ?? "Task assignment will appear here once the orchestrator surfaces the subagent prompt.";

  return (
    <section className="border-b border-border-subtle bg-surface-warm">
      <div className="mx-auto w-full max-w-chat-column px-6 py-4 md:px-8">
        <div className="surface-card rounded-md px-4 py-3">
          <header className="mb-2 flex items-center gap-2">
            <span
              aria-hidden
              className="grid size-5 place-items-center rounded bg-primary/10 text-primary"
            >
              <Plus className="size-3" strokeWidth={2.5} />
            </span>
            <span className="text-meta font-semibold uppercase tracking-eyebrow text-ink-subtle">
              <Trans>Task Assignment</Trans>
            </span>
          </header>
          <p className="text-sm leading-relaxed text-ink-muted">{description}</p>
        </div>
      </div>
    </section>
  );
}
