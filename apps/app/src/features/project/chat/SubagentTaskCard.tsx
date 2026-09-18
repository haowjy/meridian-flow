/**
 * SubagentTaskCard — warm summary strip for a subagent thread nested under the
 * active project conversation. Renders the subagent's first working-state goal
 * when one exists, and nothing at all otherwise.
 */
import { Trans } from "@lingui/react/macro";
import type { Thread } from "@meridian/contracts/protocol";

export type SubagentTaskCardProps = {
  subagent: Thread;
};

export function SubagentTaskCard({ subagent }: SubagentTaskCardProps) {
  const goal = subagent.workingState?.goals?.[0]?.trim();
  if (!goal) return null;

  return (
    <section className="border-b border-border-subtle bg-card">
      <div className="mx-auto flex w-full max-w-chat-column items-baseline gap-2 px-6 py-3 md:px-8">
        <span className="shrink-0 text-meta font-medium text-muted-foreground">
          <Trans>Goal</Trans>
        </span>
        <p className="min-w-0 text-sm leading-relaxed text-ink-muted">{goal}</p>
      </div>
    </section>
  );
}
