// ═══════════════════════════════════════════════════════════════════
// TurnActions — hover action bar for individual turns.
//
// Shows copy/edit/regenerate buttons on hover. Appears below the
// turn content. User turns get copy + edit. Assistant turns get
// copy + regenerate.
// ═══════════════════════════════════════════════════════════════════

import { memo, useCallback, useState } from "react"
import { Check, Copy, PencilSimple, ArrowsClockwise } from "@phosphor-icons/react"

import { cn } from "@/lib/utils"

import type { ThreadTurn } from "../types"

type TurnActionsProps = {
  turn: ThreadTurn
  isLoading?: boolean
  onEdit?: () => void
  onRegenerate?: () => void
  className?: string
}

function extractTextContent(turn: ThreadTurn): string {
  if (turn.role === "user") {
    return turn.blocks
      .filter((b) => b.blockType === "text")
      .map((b) => b.textContent ?? "")
      .join("")
  }

  if (turn.role === "assistant") {
    return turn.activity.items
      .filter((item) => item.kind === "content")
      .map((item) => item.text)
      .join("")
  }

  return ""
}

export const TurnActions = memo(function TurnActions({
  turn,
  isLoading = false,
  onEdit,
  onRegenerate,
  className,
}: TurnActionsProps) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(async () => {
    const text = extractTextContent(turn)
    if (!text) return

    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard API may not be available in some contexts
    }
  }, [turn])

  const buttonClass =
    "rounded p-1 transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"

  return (
    <div
      className={cn(
        "flex items-center gap-1 text-muted-foreground opacity-0 transition-opacity duration-200 group-hover/turn:opacity-100",
        className,
      )}
    >
      <button
        type="button"
        onClick={() => void handleCopy()}
        className={buttonClass}
        aria-label="Copy text"
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>

      {onEdit && (
        <button
          type="button"
          onClick={onEdit}
          disabled={isLoading}
          className={buttonClass}
          aria-label="Edit message"
        >
          <PencilSimple size={14} />
        </button>
      )}

      {onRegenerate && (
        <button
          type="button"
          onClick={onRegenerate}
          disabled={isLoading}
          className={buttonClass}
          aria-label="Regenerate response"
        >
          <ArrowsClockwise size={14} />
        </button>
      )}
    </div>
  )
})
