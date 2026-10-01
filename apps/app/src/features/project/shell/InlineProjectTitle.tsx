/**
 * The project's name, renamed in place in the desktop rail and the phone
 * drawer. Renames show at once (the rename mutation updates the cache); a
 * refused one reopens the field with the writer's text.
 */
import { t } from "@lingui/core/macro";
import { cn } from "@/lib/utils";
import { TitleEditSlot } from "./TitleEditSlot";

export type ProjectTitleEdit = { projectId: string; onSave: (title: string) => Promise<unknown> };

export function InlineProjectTitle({
  projectId,
  title,
  onSave,
  className,
  inputClassName,
  showRenameHint = false,
}: ProjectTitleEdit & {
  title: string;
  /** The resting button: geometry, typography, hover. */
  className?: string;
  /** The same geometry and typography without the hover, so editing moves nothing. */
  inputClassName?: string;
  showRenameHint?: boolean;
}) {
  return (
    <div className="relative flex min-w-0 flex-1 items-center">
      <TitleEditSlot
        titleKey={`project:${projectId}`}
        label={t`Project title`}
        failure={() => t`Project title could not be saved. Try again.`}
        rename={onSave}
        fieldClassName={cn("flex min-w-0 flex-1 items-center", inputClassName)}
        failureClassName="right-0 left-0"
      >
        {({ start, triggerRef }) => (
          <button
            ref={triggerRef}
            type="button"
            aria-label={t`Rename project: ${title}`}
            title={title}
            onClick={() => start(title)}
            className={className}
          >
            <span className="min-w-0 flex-1 cursor-text truncate">{title}</span>
            {showRenameHint ? (
              <span className="text-xs font-normal text-ink-muted">{t`Rename`}</span>
            ) : null}
          </button>
        )}
      </TitleEditSlot>
    </div>
  );
}
