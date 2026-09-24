/** Inline project-name edit shared by the desktop rail and phone drawer. */
import { t } from "@lingui/core/macro";
import { Loader2 } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export type ProjectTitleEdit = {
  pending: boolean;
  error: Error | null;
  onStart: () => void;
  onSave: (title: string) => Promise<unknown>;
};

export function InlineProjectTitle({
  title,
  pending,
  error,
  onStart,
  onSave,
  className,
  inputClassName,
  showRenameHint = false,
}: ProjectTitleEdit & {
  title: string;
  className?: string;
  inputClassName?: string;
  showRenameHint?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [validationError, setValidationError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const submitting = useRef(false);

  useLayoutEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);
  // A disabled pending input cannot take focus in the mutation's catch path.
  useEffect(() => {
    if (editing && error && !pending) inputRef.current?.focus();
  }, [editing, error, pending]);

  const stop = () => {
    setEditing(false);
    setValidationError(null);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };
  const save = async () => {
    if (submitting.current || pending) return;
    const nextTitle = draft.trim();
    if (!nextTitle) {
      setValidationError(t`Project name is required`);
      inputRef.current?.focus();
      return;
    }
    if (nextTitle === title) {
      stop();
      return;
    }
    submitting.current = true;
    setValidationError(null);
    try {
      await onSave(nextTitle);
      stop();
    } catch {
      // The mutation restores the cached title; keep the writer's draft and
      // the error here so it can be corrected or retried in place.
      return;
    } finally {
      submitting.current = false;
    }
  };

  return (
    <div className="relative flex min-w-0 flex-1 items-center">
      {editing ? (
        <>
          <Input
            ref={inputRef}
            type="text"
            value={draft}
            disabled={pending}
            aria-label={t`Project title`}
            aria-invalid={Boolean(validationError || error)}
            aria-describedby={validationError || error ? "project-title-inline-error" : undefined}
            onChange={(event) => {
              setDraft(event.target.value);
              setValidationError(null);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Enter") {
                event.preventDefault();
                void save();
              } else if (event.key === "Escape" && !pending && !submitting.current) {
                event.preventDefault();
                stop();
              }
            }}
            onBlur={() => void save()}
            className={cn("min-w-0 flex-1", inputClassName)}
          />
          {pending ? (
            <Loader2
              role="status"
              aria-label={t`Saving project title`}
              className="ml-1 size-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none"
            />
          ) : null}
        </>
      ) : (
        <button
          ref={triggerRef}
          type="button"
          aria-label={t`Rename project: ${title}`}
          title={title}
          onClick={() => {
            onStart();
            setDraft(title);
            setValidationError(null);
            setEditing(true);
          }}
          className={className}
        >
          <span className="min-w-0 flex-1 cursor-text truncate">{title}</span>
          {showRenameHint ? (
            <span className="text-xs font-normal text-ink-muted">{t`Rename`}</span>
          ) : null}
        </button>
      )}
      {editing && (validationError || error) ? (
        <p
          id="project-title-inline-error"
          role="alert"
          className="absolute top-full right-0 left-0 z-10 rounded-md border border-border bg-popover px-2 py-1.5 text-xs text-destructive shadow-sm"
        >
          {validationError ?? t`Project title could not be saved. Try again.`}
        </p>
      ) : null}
    </div>
  );
}
