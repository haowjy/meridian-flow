/** Inline project-name edit shared by the desktop rail and phone drawer. */
import { t } from "@lingui/core/macro";
import { Loader2 } from "lucide-react";
import { useRef, useState } from "react";
import { InlineEditInput } from "@/components/ui/inline-edit";
import { useInlineEdit } from "@/components/ui/use-inline-edit";
import { cn } from "@/lib/utils";

export type ProjectTitleEdit = { onSave: (title: string) => Promise<unknown> };

export function InlineProjectTitle({
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
  const [editing, setEditing] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const stop = () => {
    setEditing(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };
  return (
    <div className="relative flex min-w-0 flex-1 items-center">
      {editing ? (
        <ProjectTitleField title={title} onSave={onSave} onDone={stop} className={inputClassName} />
      ) : (
        <button
          ref={triggerRef}
          type="button"
          aria-label={t`Rename project: ${title}`}
          title={title}
          onClick={() => setEditing(true)}
          className={className}
        >
          <span className="min-w-0 flex-1 cursor-text truncate">{title}</span>
          {showRenameHint ? (
            <span className="text-xs font-normal text-ink-muted">{t`Rename`}</span>
          ) : null}
        </button>
      )}
    </div>
  );
}

function ProjectTitleField({
  title,
  onSave,
  onDone,
  className,
}: ProjectTitleEdit & { title: string; onDone: () => void; className?: string }) {
  const edit = useInlineEdit({
    initial: title,
    onCancel: onDone,
    onCommit: async (next) => {
      try {
        await onSave(next);
      } catch {
        // The mutation restores the cached title; the draft stays for a retry.
        throw new Error(t`Project title could not be saved. Try again.`);
      }
      onDone();
    },
  });
  const errorId = "project-title-inline-error";
  return (
    <>
      <div className={cn("flex min-w-0 flex-1 items-center", className)}>
        <InlineEditInput
          {...edit.inputProps}
          aria-label={t`Project title`}
          aria-describedby={edit.issue ? errorId : undefined}
        />
      </div>
      {edit.pending ? (
        <Loader2
          role="status"
          aria-label={t`Saving project title`}
          className="ml-1 size-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none"
        />
      ) : null}
      {edit.issue ? (
        <p
          id={errorId}
          role="alert"
          className="absolute top-full right-0 left-0 z-10 rounded-md border border-border bg-popover px-2 py-1.5 text-xs text-destructive shadow-sm"
        >
          {edit.issue.message}
        </p>
      ) : null}
    </>
  );
}
