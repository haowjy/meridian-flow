/** Quiet thread-scoped Changes record for trails that have no owning turn. */
import { Trans } from "@lingui/react/macro";
import { ChevronDown } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { ChangeTrailShell } from "@/client/change-trails";
import { cn } from "@/lib/utils";
import { useConversationReveal } from "./conversation-reveal";
import { ChangeViewDetail } from "./TurnEditsCard";
import type { NavigateToTrailChange } from "./useChangeTrailNavigation";

export function ThreadChangesCard({
  threadId,
  shells,
  navigateToChange,
}: {
  threadId: string;
  shells: readonly ChangeTrailShell[];
  navigateToChange: NavigateToTrailChange;
}) {
  const panelId = useId();
  const cardRef = useRef<HTMLDivElement>(null);
  const reveal = useConversationReveal(threadId);
  const [expanded, setExpanded] = useState(false);
  const [activeReveal, setActiveReveal] = useState<typeof reveal>(null);

  useEffect(() => {
    if (reveal?.turnId !== null) return;
    setActiveReveal(reveal);
    setExpanded(true);
    cardRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [reveal]);

  return (
    <div
      ref={cardRef}
      className="overflow-hidden rounded-lg border border-border bg-chat-interactive text-caption text-ink-muted"
      data-thread-changes-card
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => setExpanded((value) => !value)}
        className="focus-ring flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted"
      >
        <ChevronDown
          className={cn(
            "size-3.5 shrink-0 text-ink-subtle transition-transform",
            expanded && "rotate-180",
          )}
          aria-hidden
        />
        <span aria-hidden className="text-ink-subtle">
          ✎
        </span>
        <span className="font-medium text-prose-foreground">
          <Trans>Changes across this conversation</Trans>
        </span>
      </button>
      {expanded ? (
        <div id={panelId} className="border-border-subtle border-t py-1">
          {shells.map((shell) => (
            <ChangeViewDetail
              key={shell.trailId}
              threadId={threadId}
              shell={shell}
              navigateToChange={navigateToChange}
              reveal={activeReveal}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
