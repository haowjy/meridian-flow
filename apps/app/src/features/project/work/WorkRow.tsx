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
  work: Pick<Work, "id" | "name" | "goal"> & Partial<Pick<Work, "status" | "lastActivityAt">>;
  now: number;
  onOpen: () => void;
  actions?: ReactNode;
  liveState?: ReactNode;
  gone?: boolean;
  notice?: ReactNode;
}) {
  const named = useWorks(projectId).nameOf(work);
  return (
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
