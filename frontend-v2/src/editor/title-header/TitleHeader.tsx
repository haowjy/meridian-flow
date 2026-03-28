import { cn } from "@/lib/utils"

import { ExportDropdown } from "../export/ExportDropdown"
import {
  ConnectionStatus,
  type CollabConnectionState,
} from "./ConnectionStatus"
import { RenameInput } from "./RenameInput"
import { WordCount } from "./WordCount"

export interface TitleHeaderProps {
  /** Document name displayed in the header */
  documentName: string
  /** Called when the user renames the document */
  onRename?: (newName: string) => void
  /** Connection status for the collab indicator */
  connectionState?: CollabConnectionState
  /** Total word count from EditorContentAPI.getWordCount() */
  wordCount?: number
  /** Selected text word count (0 when no selection) */
  selectionWordCount?: number
  /** Last saved time as a relative string (e.g., "2m ago") */
  lastSaved?: string
  /** Callback to get the document content for export */
  getContent?: () => string
  className?: string
}

/**
 * Document title header bar — sits below the tab bar, above the editor.
 *
 * Layout (Google Docs style):
 * ```
 * [Document Name]          [Status] [Word Count] [Last Saved] [Export]
 * ```
 */
export function TitleHeader({
  documentName,
  onRename,
  connectionState = "disconnected",
  wordCount = 0,
  selectionWordCount = 0,
  lastSaved,
  getContent,
  className,
}: TitleHeaderProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 border-b border-border/80 px-4 py-2",
        className,
      )}
    >
      {/* Left: document name */}
      <div className="flex-1 min-w-0">
        <RenameInput
          name={documentName}
          onRename={onRename ?? (() => {})}
        />
      </div>

      {/* Right: status indicators + export */}
      <div className="flex items-center gap-3 shrink-0">
        <ConnectionStatus state={connectionState} />

        <WordCount
          totalWords={wordCount}
          selectionWords={selectionWordCount}
        />

        {lastSaved && (
          <span className="text-xs text-muted-foreground">
            {lastSaved}
          </span>
        )}

        <ExportDropdown
          documentName={documentName}
          getContent={getContent}
        />
      </div>
    </div>
  )
}
