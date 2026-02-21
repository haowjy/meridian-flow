/**
 * ProposalHunkEditDialog — modal dialog for editing a hunk's suggested text
 * before applying it.
 *
 * Prefills with the hunk's current insertedText. The writer can modify the
 * text and either confirm (Apply) or cancel. Empty string "" is valid input
 * — it means "delete the old text and insert nothing" (not coerced to absent).
 *
 * Keyboard support:
 * - Escape: cancel (handled by Radix Dialog)
 * - Ctrl/Cmd+Enter: apply
 */

import { useCallback, useEffect, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/components/ui/dialog";
import { Button } from "@/shared/components/ui/button";
import type { HunkEditSession } from "@/core/cm6-collab";

interface ProposalHunkEditDialogProps {
  editSession: HunkEditSession | null;
  onUpdateDraft: (draftText: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}

export function ProposalHunkEditDialog({
  editSession,
  onUpdateDraft,
  onCommit,
  onCancel,
}: ProposalHunkEditDialogProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const isOpen = editSession !== null;

  // Auto-focus textarea when dialog opens
  useEffect(() => {
    if (isOpen) {
      // Defer focus to after Radix animation completes
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
        // Place cursor at the end
        const len = textareaRef.current?.value.length ?? 0;
        textareaRef.current?.setSelectionRange(len, len);
      });
    }
  }, [isOpen]);

  // Ctrl/Cmd+Enter to apply
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        onCommit();
      }
    },
    [onCommit],
  );

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Edit Suggestion</DialogTitle>
          <DialogDescription>
            Modify the suggested text before applying it to your document.
          </DialogDescription>
        </DialogHeader>

        <textarea
          ref={textareaRef}
          className="border-input bg-background text-foreground placeholder:text-muted-foreground min-h-[160px] w-full resize-y rounded-md border px-3 py-2 font-mono text-sm leading-relaxed focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:outline-none"
          value={editSession?.draftInsertedText ?? ""}
          onChange={(e) => onUpdateDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Enter replacement text..."
        />

        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={onCommit}>
            Apply
            <kbd className="text-muted-foreground ml-1.5 text-[10px]">
              {typeof navigator !== "undefined" && navigator.platform.includes("Mac") ? "\u2318" : "Ctrl"}+\u23CE
            </kbd>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
