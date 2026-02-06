import { InlineEditor } from "@/shared/components/InlineEditor";

interface InlineNameEditorProps {
  initialValue: string;
  existingNames: string[];
  onSubmit: (name: string) => void;
  onCancel: () => void;
  /**
   * Mode affects validation + blur behavior:
   * - 'rename' (default): used for existing items, enforces duplicate checks and
   *   submits on blur when valid.
   * - 'create': used for new, temporary items. Duplicate checks are skipped
   *   (uniqueness handled by caller) and blur only submits if the user actually
   *   changed the name from its initial value. Otherwise blur cancels.
   */
  mode?: "rename" | "create";
  /**
   * Optional file extension to display (read-only) next to the input.
   * Shows the extension that will be appended to the name on submit.
   * Helps prevent visual jump between view and edit modes.
   */
  extension?: string;
  className?: string;
  type?: "folder" | "document"; // NEW: item type
  isRootLevel?: boolean; // NEW: whether at root level
}

/**
 * Inline text input for renaming documents/folders in the tree.
 *
 * Wrapper around shared InlineEditor component with document-specific defaults:
 * - Enforces duplicate checks in 'rename' mode
 * - Allows duplicates in 'create' mode (caller handles uniqueness)
 * - Displays file extension suffix (.md)
 *
 * Usage: DocumentTreeItem, FolderTreeItem
 */
export function InlineNameEditor({
  initialValue,
  existingNames,
  onSubmit,
  onCancel,
  mode = "rename",
  extension,
  className,
  type, // NEW
  isRootLevel, // NEW
}: InlineNameEditorProps) {
  return (
    <InlineEditor
      value={initialValue}
      existingNames={existingNames}
      onSubmit={onSubmit}
      onCancel={onCancel}
      mode={mode}
      suffix={extension}
      allowDuplicates={mode === "create"}
      fontWeight="normal"
      className={className}
      type={type}
      isRootLevel={isRootLevel}
    />
  );
}
