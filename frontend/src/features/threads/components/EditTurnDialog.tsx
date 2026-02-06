import React, { useState, useEffect, useMemo } from "react";
import { Card } from "@/shared/components/ui/card";
import { cn } from "@/lib/utils";
import { makeLogger } from "@/core/lib/logger";
import { AutosizeTextarea } from "@/features/threads/components/AutosizeTextarea";
import { userTurnCardBase } from "./styles";
import { ThreadRequestControls } from "@/features/threads/components/ThreadRequestControls";
import type {
  ThreadRequestOptions,
  RequestParams,
} from "@/features/threads/types";
import { requestParamsToOptions } from "@/features/threads/types";

const log = makeLogger("edit-turn-dialog");

interface EditTurnDialogProps {
  isOpen: boolean;
  onClose: () => void;
  initialContent: string;
  /** Original request params from the turn being edited */
  originalRequestParams?: RequestParams | null;
  onSave: (content: string, options: ThreadRequestOptions) => Promise<void>;
}

export function EditTurnDialog({
  isOpen,
  onClose,
  initialContent,
  originalRequestParams,
  onSave,
}: EditTurnDialogProps) {
  const [content, setContent] = useState(initialContent);
  const [isSaving, setIsSaving] = useState(false);

  // Initialize options from original request params
  const initialOptions = useMemo(
    () => requestParamsToOptions(originalRequestParams),
    [originalRequestParams],
  );
  const [options, setOptions] = useState<ThreadRequestOptions>(initialOptions);

  // Reset content and options when dialog opens
  useEffect(() => {
    if (isOpen) {
      setContent(initialContent);
      setOptions(requestParamsToOptions(originalRequestParams));
    }
  }, [isOpen, initialContent, originalRequestParams]);

  const handleSave = async () => {
    // Validate content before saving
    if (!content.trim()) return;

    setIsSaving(true);
    try {
      await onSave(content, options);
      onClose();
    } catch (error) {
      log.error("Failed to save turn:", error);
    } finally {
      setIsSaving(false);
    }
  };

  if (!isOpen) return null;

  // Card styling synced with UserTurn via userTurnCardBase
  // gap-2 overrides Card's gap-6, w-full for textarea width
  return (
    <Card className={cn(userTurnCardBase, "w-full gap-2")}>
      <AutosizeTextarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="Edit your message..."
        focusKey={isOpen ? "edit" : null}
        maxHeight="50vh"
        minHeight={0}
        className="px-0 py-0" // Card px-3 py-2 handles padding
        onKeyDown={(event) => {
          // Enter → save (consistent with TurnInput)
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            if (!isSaving && content.trim()) handleSave();
            return;
          }

          // Escape → close
          if (event.key === "Escape") {
            event.preventDefault();
            if (!isSaving) onClose();
          }
        }}
      />
      <ThreadRequestControls
        options={options}
        onOptionsChange={setOptions}
        onSend={handleSave}
        isSendDisabled={isSaving || !content.trim()}
        saveIcon
      />
    </Card>
  );
}
