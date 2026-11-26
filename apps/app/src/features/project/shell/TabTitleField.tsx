import { InlineEditInput } from "@/components/ui/inline-edit";
import { useInlineEdit } from "@/components/ui/use-inline-edit";

export function TabTitleField({
  initial,
  unchanged,
  label,
  maxLength,
  describedBy,
  invalid,
  focusOnMount,
  onCommit,
  onCancel,
  className = "pane-title flex min-w-0 px-1",
}: {
  initial: string;
  unchanged?: string;
  label: string;
  maxLength?: number;
  describedBy?: string;
  invalid?: boolean;
  focusOnMount?: boolean;
  /** Receives the trimmed draft; an empty or unchanged draft cancels instead. */
  onCommit: (title: string) => void;
  onCancel: () => void;
  className?: string;
}) {
  const edit = useInlineEdit({ initial, unchanged, focusOnMount, onCommit, onCancel });
  return (
    <span className={className}>
      <InlineEditInput
        {...edit.inputProps}
        maxLength={maxLength}
        aria-label={label}
        aria-describedby={describedBy}
        aria-invalid={edit.inputProps["aria-invalid"] ?? (invalid || undefined)}
      />
    </span>
  );
}
