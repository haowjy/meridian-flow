import { t } from "@lingui/core/macro";
import type { Ref } from "react";
import { LabelNote } from "@/components/ui/marks";
import { cn } from "@/lib/utils";
import { type TitleEditHandle, TitleEditSlot } from "./TitleEditSlot";

export type ProjectTitleEdit = { projectId: string; onSave: (title: string) => Promise<unknown> };

export function InlineProjectTitle({
  editRef,
  projectId,
  title,
  onSave,
  className,
  inputClassName,
  showRenameHint = false,
}: ProjectTitleEdit & {
  editRef?: Ref<TitleEditHandle>;
  title: string;
  className?: string;
  inputClassName?: string;
  showRenameHint?: boolean;
}) {
  return (
    <div className="relative flex min-w-0 flex-1 items-center">
      <TitleEditSlot
        editRef={editRef}
        titleKey={`project:${projectId}`}
        label={t`Project title`}
        failure={() => t`Couldn't save`}
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
            {showRenameHint ? <LabelNote className="font-normal">{t`Rename`}</LabelNote> : null}
          </button>
        )}
      </TitleEditSlot>
    </div>
  );
}
