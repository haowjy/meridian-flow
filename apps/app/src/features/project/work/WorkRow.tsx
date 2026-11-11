/**
 * A Work list row in the app's list grammar (Chats, Editor recents): name and
 * the AI's status over the first line of its goal, a relative age, and the
 * shared Work actions menu.
 */
import { t } from "@lingui/core/macro";
import type { Work } from "@meridian/contracts/works";
import type { ReactNode } from "react";
import { ListRow } from "@/components/ui/list-row";
import { relativeTime } from "../relative-time";
import { WorkTitleLine } from "./WorkTitleLine";

export function WorkRow({
  work,
  now,
  onOpen,
  actions,
  liveState,
}: {
  /** A Work still being created has no status yet. */
  work: Pick<Work, "name" | "goal" | "lastActivityAt"> & Partial<Pick<Work, "status">>;
  now: number;
  onOpen: () => void;
  /** Trailing menu; absent while the Work has no server identity yet. */
  actions?: ReactNode;
  /** Replaces the age with a live state such as Creating. */
  liveState?: ReactNode;
}) {
  return (
    // The row's inset hangs in the list's gutter, so names stay on the page's edge.
    <div className="px-0.5">
      <ListRow
        onOpen={onOpen}
        controlProps={{
          "aria-label": work.status ? t`Open ${work.name} (${work.status})` : t`Open ${work.name}`,
        }}
        title={
          <WorkTitleLine
            title={<span className="truncate">{work.name}</span>}
            status={work.status}
          />
        }
        detail={work.goal ? (work.goal.split("\n").find((line) => line.trim()) ?? "") : null}
        meta={liveState ? null : relativeTime(work.lastActivityAt, now)}
        // A live state is announced, so it sits beside the control, not inside its name.
        actions={
          liveState || actions ? (
            <>
              {liveState ? (
                <span className="px-1.5 text-xs text-muted-foreground">{liveState}</span>
              ) : null}
              {actions}
            </>
          ) : null
        }
      />
    </div>
  );
}
