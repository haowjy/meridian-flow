import {
  useState,
  useRef,
  useEffect,
  KeyboardEvent,
  ChangeEvent,
  PointerEvent,
} from "react";
import { Check, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { validateName, type ValidationType } from "@/core/lib/nameValidation";

interface InlineEditorProps {
  value: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;

  // Validation
  existingNames?: string[];
  allowDuplicates?: boolean;
  type?: ValidationType; // NEW: 'folder' | 'document' for validation
  isRootLevel?: boolean; // NEW: whether this is at root level

  // Display
  suffix?: string; // e.g., ".md" for documents
  fontWeight?: "normal" | "medium";
  className?: string;

  // Advanced behavior
  mode?: "rename" | "create";
  placeholder?: string;

  // Width behavior
  widthClass?: string; // Custom width class (e.g., "w-2/5"), defaults to "w-full"
}

/**
 * Unified inline editor for all rename/edit operations.
 *
 * Design System Pattern:
 * - Box border with rounded-sm (feels contained and crafted)
 * - Subtle focus ring for clear affordance
 * - Hover-reveal Check/Cancel buttons (clean until needed)
 * - Optional suffix display to prevent layout shift
 *
 * Usage:
 * - Document/folder names (tree)
 * - Thread titles (list and header)
 * - Any other inline text editing needs
 *
 * Behavior:
 * - Auto-focus + select on mount
 * - Blur guards prevent premature cancel
 * - Enter submits, Escape cancels
 * - Empty input = cancel (not error)
 */
export function InlineEditor({
  value: initialValue,
  onSubmit,
  onCancel,
  existingNames = [],
  allowDuplicates = false,
  type, // NEW
  isRootLevel, // NEW
  suffix,
  fontWeight = "normal",
  className,
  mode = "rename",
  placeholder,
  widthClass,
}: InlineEditorProps) {
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);
  // Tracks whether the user has actually changed the text.
  // This lets us distinguish between initial focus/blur races (e.g. after
  // selecting a context menu item) and intentional edits.
  const [hasUserEdited, setHasUserEdited] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const mountTimeRef = useRef<number | null>(null);

  // Auto-focus and select all text on mount
  // Use requestAnimationFrame to wait for next paint (avoids race with render/animations)
  useEffect(() => {
    mountTimeRef.current = performance.now();

    requestAnimationFrame(() => {
      if (inputRef.current) {
        inputRef.current.focus({ preventScroll: true });
        inputRef.current.select();
      }
    });
  }, []);

  const validate = (name: string): string | null => {
    return validateName(name, {
      type,
      isRootLevel,
      existingNames,
      currentName: initialValue,
      allowDuplicates,
    });
  };

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    setValue(newValue);
    if (!hasUserEdited) {
      setHasUserEdited(true);
    }
    // Run validation on every keystroke for instant feedback
    const validationError = validate(newValue);
    setError(validationError);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const trimmed = value.trim();
      // Hitting Enter on an empty name should behave like cancel rather than
      // showing a validation error. This matches the blur behavior and keeps
      // the inline UX lightweight.
      if (!trimmed) {
        onCancel();
        return;
      }
      const validationError = validate(trimmed);
      if (validationError) {
        setError(validationError);
        return;
      }
      onSubmit(trimmed);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  };

  const handleConfirmPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    // Treat clicking/tapping the checkmark as an explicit "submit" action that mirrors
    // pressing Enter, but without relying on blur ordering.
    // Uses PointerEvent instead of MouseEvent for touch device reliability.
    e.preventDefault();
    e.stopPropagation();

    const trimmed = value.trim();
    const validationError = validate(trimmed);
    if (validationError) {
      setError(validationError);
      return;
    }
    onSubmit(trimmed);
  };

  const handleCancelPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    // Prevent the input from blurring first, which would otherwise trigger
    // blur handlers that might submit a rename. For both create and rename
    // flows, an explicit "X" click/tap should be treated as a hard cancel.
    // Uses PointerEvent instead of MouseEvent for touch device reliability.
    e.preventDefault();
    e.stopPropagation();
    onCancel();
  };

  const handleBlur = () => {
    const trimmed = value.trim();

    // Guard against transient blur immediately after we start an inline edit,
    // which can happen when menus close or when the user is still in the
    // mouse-down/mouse-up sequence from the action that opened the editor.
    // If the user hasn't typed yet and the blur happens very soon after mount,
    // re-focus the input instead of treating it as a real blur.
    if (!hasUserEdited && mountTimeRef.current !== null) {
      const elapsed = performance.now() - mountTimeRef.current;
      if (elapsed < 200) {
        requestAnimationFrame(() => {
          if (inputRef.current) {
            inputRef.current.focus({ preventScroll: true });
            inputRef.current.select();
          }
        });
        return;
      }
    }

    // For create mode (new temp item), treat blur as a "soft" action:
    // - If user hasn't typed yet, ignore the first blur. This prevents
    //   context-menu focus races from immediately cancelling the edit.
    // - If name is empty after user edits -> cancel (do not create).
    // - If name is unchanged from the initial value after user edits
    //   (e.g., they typed then reverted) -> cancel.
    // - If user edited the name to a non-empty value -> submit if valid.
    if (mode === "create") {
      if (!hasUserEdited) {
        // Ignore initial blur when the user hasn't interacted with the field.
        // The temp item remains visible and can still be edited or cancelled
        // explicitly with Escape.
        return;
      }

      if (!trimmed) {
        onCancel();
        return;
      }

      // Only auto-create on blur if user actually changed the name.
      if (trimmed === initialValue.trim()) {
        onCancel();
        return;
      }

      const validationError = validate(trimmed);
      if (!validationError) {
        onSubmit(trimmed);
      } else {
        onCancel();
      }
      return;
    }

    // Rename mode (existing items): submit if valid, cancel if empty/invalid.
    // This sidesteps focus race conditions from dropdown/context menus
    // and matches OS behavior (Finder, Explorer, VS Code).
    const validationError = validate(trimmed);
    if (trimmed && !validationError) {
      onSubmit(trimmed);
    } else {
      onCancel();
    }
  };

  const actionButtonClass = cn(
    "flex flex-shrink-0 items-center justify-center rounded p-0.5 touch-target-sm",
    "text-muted-foreground hover:text-foreground",
    // Hover-reveal for clean UI until needed.
    // Also reveal on focus-within so touch/keyboard users can see actions.
    "opacity-0 pointer-events-none",
    "group-hover:opacity-100 group-hover:pointer-events-auto",
    "group-focus-within:opacity-100 group-focus-within:pointer-events-auto",
    "focus:opacity-100 focus:pointer-events-auto",
    "transition-opacity",
  );

  return (
    <div className={cn("group min-w-0", widthClass ?? "flex-1")}>
      <div className="flex items-center gap-2 md:gap-1.5">
        <div className="flex min-w-0 flex-1 items-center">
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
            placeholder={placeholder}
            className={cn(
              // Typography - responsive size with context-specific weight
              "text-sm",
              fontWeight === "medium" ? "font-medium" : "font-normal",
              // Box style with subtle border (crafted and contained)
              "bg-background border-input rounded-sm border px-1.5 py-0.5",
              // Focus ring for clear affordance (ring-inset prevents visual height change)
              "focus:ring-ring outline-none ring-inset focus:ring-1",
              // Error state
              error && "border-destructive focus:ring-destructive",
              // Width - parent wrapper controls overall width
              suffix ? "min-w-0 flex-1" : "w-full",
              // Smooth color transitions only (not dimensions) to prevent layout shift
              "transition-colors duration-150",
              className,
            )}
            aria-invalid={!!error}
            aria-describedby={error ? "inline-editor-error" : undefined}
          />
          {suffix && (
            <span className="text-muted-foreground ml-1 flex-shrink-0 text-xs">
              {suffix}
            </span>
          )}
        </div>
        <button
          type="button"
          onPointerDown={handleConfirmPointerDown}
          className={actionButtonClass}
          aria-label="Confirm"
        >
          <Check className="size-4 md:size-3" />
        </button>
        <button
          type="button"
          onPointerDown={handleCancelPointerDown}
          className={actionButtonClass}
          aria-label="Cancel"
        >
          <X className="size-4 md:size-3" />
        </button>
      </div>
      {error && (
        <p
          id="inline-editor-error"
          className="text-destructive mt-0.5 truncate text-xs"
        >
          {error}
        </p>
      )}
    </div>
  );
}
