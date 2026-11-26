import { InlineEditInput } from "@/components/ui/inline-edit";
import type { InlineEdit } from "@/components/ui/use-inline-edit";
import { cn } from "@/lib/utils";
import { InlineValidationOverlay } from "./InlineValidationOverlay";

export function EntryNameField({
  form,
  label,
  placeholder,
  className,
}: {
  form: InlineEdit;
  label: string;
  placeholder?: string;
  className?: string;
}) {
  return (
    <div className={cn("relative flex min-w-0 flex-1 items-center", className)}>
      <InlineEditInput
        {...form.inputProps}
        aria-label={label}
        placeholder={placeholder}
        enterKeyHint="done"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
      />
      <InlineValidationOverlay anchorRef={form.inputRef} severity={form.issue} />
    </div>
  );
}
