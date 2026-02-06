import { InlineEditor } from "@/shared/components/InlineEditor";

interface ThreadTitleEditorProps {
  initialValue: string;
  onSubmit: (title: string) => void;
  onCancel: () => void;
  widthClass?: string;
}

/**
 * Inline input for editing thread titles.
 *
 * Wrapper around shared InlineEditor component with thread-specific defaults:
 * - Medium font weight (500) for header/list prominence
 * - Allows duplicates (threads can have same titles)
 * - No validation beyond empty check
 *
 * Visual upgrade from previous underline implementation:
 * - Box border with rounded-sm (more crafted feel)
 * - Focus ring for clear affordance
 * - Hover-reveal Check/Cancel buttons
 *
 * Usage: ThreadRow (sidebar), ThreadHeader (center panel)
 */
export function ThreadTitleEditor({
  initialValue,
  onSubmit,
  onCancel,
  widthClass,
}: ThreadTitleEditorProps) {
  return (
    <InlineEditor
      value={initialValue}
      onSubmit={onSubmit}
      onCancel={onCancel}
      fontWeight="medium"
      allowDuplicates
      widthClass={widthClass}
      className="h-7 text-sm"
    />
  );
}
