/**
 * Document Status
 *
 * Compact display of word count and save status for the editor header.
 */

import { SaveStatusIcon } from "./SaveStatusIcon";
import type { SaveStatus } from "@/shared/components/ui/StatusBadge";
import type { CollabConnectionState } from "../stores/useCollabStore";
import { CollabConnectionIndicator } from "./CollabConnectionIndicator";

interface DocumentStatusProps {
  wordCount: number;
  status?: SaveStatus;
  lastSaved: Date | null;
  collabEnabled?: boolean;
  collabConnectionState?: CollabConnectionState;
}

export function DocumentStatus({
  wordCount,
  status,
  lastSaved,
  collabEnabled = false,
  collabConnectionState,
}: DocumentStatusProps) {
  const showCollabStatus =
    collabEnabled === true && collabConnectionState !== undefined;

  return (
    <div className="text-muted-foreground flex items-center gap-2 text-xs select-none">
      <span>
        {wordCount} {wordCount === 1 ? "word" : "words"}
      </span>
      {showCollabStatus && collabConnectionState ? (
        <div className="text-muted-foreground/80 flex items-center text-[11px]">
          <CollabConnectionIndicator
            state={collabConnectionState}
            className="size-3.5"
          />
        </div>
      ) : (
        status && (
          <div className="text-muted-foreground/80 flex items-center gap-1 text-[11px]">
            <SaveStatusIcon status={status} className="size-3.5" />
            {lastSaved && (
              <span aria-label="Last saved timestamp">
                {lastSaved.toLocaleTimeString()}
              </span>
            )}
          </div>
        )
      )}
    </div>
  );
}
