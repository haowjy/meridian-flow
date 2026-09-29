/**
 * TabTitleField — renames a pane band's active tab inside the tab itself.
 *
 * Renders in place of the tab's title text with the same `pane-title`
 * typography and the same inset, so the words do not move or resize; the field
 * is only as wide as its text. Enter or blur commits, Escape cancels.
 */
import { InlineEditInput } from "@/components/ui/inline-edit";
import { useInlineEdit } from "@/components/ui/use-inline-edit";

export function TabTitleField({
  initial,
  unchanged,
  label,
  maxLength,
  describedBy,
  onCommit,
  onCancel,
  className = "pane-title flex min-w-0 px-1",
}: {
  initial: string;
  /** The draft that means "no change"; defaults to `initial`. */
  unchanged?: string;
  label: string;
  maxLength?: number;
  /** Id of text that describes the field, such as a refused rename. */
  describedBy?: string;
  /** Receives the trimmed draft; an empty or unchanged draft cancels instead. */
  onCommit: (title: string) => void;
  onCancel: () => void;
  /** Wrapper typography and inset; defaults to the pane band's title. */
  className?: string;
}) {
  const edit = useInlineEdit({ initial, unchanged, onCommit, onCancel });
  return (
    <span className={className}>
      <InlineEditInput
        {...edit.inputProps}
        maxLength={maxLength}
        aria-label={label}
        aria-describedby={describedBy}
      />
    </span>
  );
}
