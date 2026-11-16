/**
 * A Work list row in the app's list grammar (Chats, Editor recents): name and
 * the AI's status over the first line of its goal, a relative age, and the
 * shared Work actions menu.
 */
import { t } from "@lingui/core/macro";
import type { Work } from "@meridian/contracts/works";
import type { ReactNode } from "react";
import { useWorks } from "@/client/query/useWorks";
import { WorkName } from "@/components/app/WorkName";
import { ListRow } from "@/components/ui/list-row";
import { LabelNote } from "@/components/ui/marks";
import { relativeTime } from "../relative-time";
import { WorkTitleLine } from "./WorkTitleLine";

export function WorkRow({
  projectId,
  work,
  now,
  onOpen,
  actions,
  liveState,
  gone = false,
  notice,
}: {
  projectId: string;
  /** A Work still being created has no status yet; a purged one has no age. */
  work: Pick<Work, "id" | "name" | "goal"> & Partial<Pick<Work, "status" | "lastActivityAt">>;
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
  const named = useWorks(projectId).nameOf(work);
  return (
    // The row's inset hangs in the list's gutter, so names stay on the page's edge.
    <div className="px-0.5">
      <ListRow
        onOpen={onOpen}
        gone={gone}
        notice={notice}
        controlProps={{
          "aria-label": work.status ? t`Open ${named} (${work.status})` : t`Open ${named}`,
          ...(!gone ? { "data-work-id": work.id } : {}),
        }}
        title={
          <WorkTitleLine title={<WorkName work={{ ...work, projectId }} />} status={work.status} />
        }
        detail={work.goal ? (work.goal.split("\n").find((line) => line.trim()) ?? "") : null}
        meta={liveState || !work.lastActivityAt ? null : relativeTime(work.lastActivityAt, now)}
        // A live state is announced, so it sits beside the control, not inside its name.
        actions={
          liveState || actions ? (
            <>
              {liveState ? <LabelNote className="px-1.5">{liveState}</LabelNote> : null}
              {actions}
            </>
          ) : null
        }
      />
    </div>
  );
}
