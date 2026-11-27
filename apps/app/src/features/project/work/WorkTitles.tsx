import { t } from "@lingui/core/macro";
import { isWorkArchived, type Work } from "@meridian/contracts/works";
import { useWorkMutations, WorkReturnedError } from "@/client/query/work-mutations";
import { workClosedSentence, workUpdateFailure } from "@/client/query/work-update-failure";
import { role } from "@/components/ui/roles";
import { cn } from "@/lib/utils";
import { TitleEditSlot } from "../shell/TitleEditSlot";

const headingClass = cn("relative flex min-w-0", role.pageHeading);

const renameFailure = (cause: unknown) => workUpdateFailure(cause, t`Couldn’t rename this Work`);

const closedSentence = (cause: unknown) =>
  cause instanceof WorkReturnedError ? workClosedSentence(cause.why) : null;

export function useWorkRename(projectId: string, work: Work) {
  const { update } = useWorkMutations(projectId);
  return async (name: string) => {
    const error = await update({ workId: work.id, data: { name } });
    if (error) throw error;
  };
}

export function WorkHeading({ projectId, work }: { projectId: string; work: Work }) {
  const rename = useWorkRename(projectId, work);
  const archived = isWorkArchived(work);
  return (
    <h1 className={headingClass}>
      <TitleEditSlot
        titleKey={`work:${work.id}`}
        label={t`Rename Work`}
        failure={renameFailure}
        closed={closedSentence}
        rename={rename}
        fieldClassName="flex min-w-0"
      >
        {({ start, triggerRef }) =>
          archived ? (
            <span title={work.name} className="min-w-0 truncate">
              {work.name}
            </span>
          ) : (
            <button
              ref={triggerRef}
              type="button"
              title={work.name}
              onClick={() => start(work.name)}
              className="inline-edit-trigger focus-ring min-w-0 truncate text-left"
            >
              {work.name}
            </button>
          )
        }
      </TitleEditSlot>
    </h1>
  );
}

export function PlainWorkHeading({ name }: { name: string }) {
  return (
    <h1 className={headingClass}>
      <span title={name} className="min-w-0 truncate">
        {name}
      </span>
    </h1>
  );
}
