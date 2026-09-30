/**
 * A Work list row in the app's list grammar (Chats, Editor recents): name and
 * the AI's status over the first line of its goal, a relative age, and the
 * shared Work actions menu.
 */
import { t } from "@lingui/core/macro";
import type { Work } from "@meridian/contracts/works";
import type { MouseEvent, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { relativeTime } from "../relative-time";
import { WorkTitleLine } from "./WorkTitleLine";

export function WorkRow({
  work,
  href,
  now,
  onOpen,
  actions,
  liveState,
}: {
  /** A Work still being created has no status yet. */
  work: Pick<Work, "name" | "goal" | "lastActivityAt"> & Partial<Pick<Work, "status">>;
  href: string;
  now: number;
  onOpen: () => void;
  /** Trailing menu; absent while the Work has no server identity yet. */
  actions?: ReactNode;
  /** Replaces the age with a live state such as Creating. */
  liveState?: ReactNode;
}) {
  return (
    <div className="group relative flex min-h-12 min-w-0 items-center gap-3 rounded-md px-2 py-1.5 transition-colors motion-reduce:transition-none hover:bg-dropdown-hover">
      <a
        href={href}
        onClick={(event: MouseEvent<HTMLAnchorElement>) => {
          if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
            return;
          event.preventDefault();
          onOpen();
        }}
        className="focus-ring min-w-0 flex-1 rounded-sm after:absolute after:inset-0"
      >
        <span className="sr-only">
          {work.status ? t`Open ${work.name} (${work.status})` : t`Open ${work.name}`}
        </span>
        <div aria-hidden>
          <WorkTitleLine
            title={
              <span className="truncate text-sm font-medium text-foreground">{work.name}</span>
            }
            status={work.status}
          />
        </div>
        {work.goal ? (
          <span aria-hidden className="block truncate text-xs text-muted-foreground">
            {work.goal.split("\n").find((line) => line.trim()) ?? ""}
          </span>
        ) : null}
      </a>
      <span
        className={cn(
          "shrink-0 text-xs tabular-nums",
          liveState ? "text-muted-foreground" : "text-ink-subtle",
        )}
      >
        {liveState ?? relativeTime(work.lastActivityAt, now)}
      </span>
      {actions ? <div className="relative z-10 -my-1 shrink-0">{actions}</div> : null}
    </div>
  );
}
