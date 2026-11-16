/**
 * A Work list row in the app's list grammar (Chats, Editor recents): name and
 * the AI's status over the first line of its goal, a relative age, and the
 * shared Work actions menu.
 */
import { t } from "@lingui/core/macro";
import type { Work } from "@meridian/contracts/works";
import type { ReactNode } from "react";
import { WorkHandle } from "@/components/app/WorkIdentity";
import { ListRow } from "@/components/ui/list-row";
import { relativeTime } from "../relative-time";
import { WorkTitleLine } from "./WorkTitleLine";

export function WorkRow({
  work,
  handle,
  now,
  onOpen,
  actions,
  liveState,
  gone = false,
  notice,
}: {
  /** A Work still being created has no status yet; a purged one has no age. */
  work: Pick<Work, "name" | "goal"> & Partial<Pick<Work, "status" | "id" | "lastActivityAt">>;
  /** Its handle, where another Work shares its name (`WorkHandleOf`). */
  handle?: string | null;
  now: number;
  onOpen: () => void;
  /** Trailing menu; absent while the Work has no server identity yet. */
  actions?: ReactNode;
  /** Replaces the age with a live state such as Creating. */
  liveState?: ReactNode;
  /** Deleted, while its Undo shows (`notice`): struck through, and it opens nothing. */
  gone?: boolean;
  /** What just happened to the Work (`RowWord`), in the age's place. */
  notice?: ReactNode;
}) {
  return (
    // The row's inset hangs in the list's gutter, so names stay on the page's edge.
    <div className="px-0.5">
      <ListRow
        onOpen={onOpen}
        gone={gone}
        notice={notice}
        controlProps={{
          "aria-label": work.status ? t`Open ${work.name} (${work.status})` : t`Open ${work.name}`,
          ...(work.id && !gone ? { "data-work-id": work.id } : {}),
        }}
        title={
          <WorkTitleLine
            title={
              <span className="flex min-w-0 items-baseline gap-1.5">
                <span className="truncate">{work.name}</span>
                <WorkHandle handle={handle} />
              </span>
            }
            status={work.status}
          />
        }
        detail={work.goal ? (work.goal.split("\n").find((line) => line.trim()) ?? "") : null}
        meta={liveState || !work.lastActivityAt ? null : relativeTime(work.lastActivityAt, now)}
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
