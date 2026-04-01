import { ArrowUp, Brain, CaretDown } from "@phosphor-icons/react"
import { useMemo, useState } from "react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

type ReasoningLevel = "off" | "low" | "medium" | "high"

type MockModel = {
  id: string
  name: string
  contextWindow: string
}

const MOCK_MODELS: MockModel[] = [
  { id: "claude-sonnet-4", name: "Claude Sonnet 4", contextWindow: "200K" },
  { id: "gpt-5.4-mini", name: "GPT-5.4 Mini", contextWindow: "128K" },
  { id: "kimi-k2", name: "Kimi K2", contextWindow: "128K" },
]

const REASONING_LEVELS: ReasoningLevel[] = ["off", "low", "medium", "high"]

const REASONING_LABELS: Record<ReasoningLevel, string> = {
  off: "Off",
  low: "Low",
  medium: "Medium",
  high: "High",
}

export interface ComposerControlsProps {
  hasContent: boolean
  isStreaming?: boolean
  onSend: () => void
  onStop?: () => void
  className?: string
}

export function ComposerControls({
  hasContent,
  isStreaming = false,
  onSend,
  onStop,
  className,
}: ComposerControlsProps) {
  const [selectedModelId, setSelectedModelId] = useState(MOCK_MODELS[0]?.id ?? "")
  const [reasoning, setReasoning] = useState<ReasoningLevel>("off")

  const selectedModel = useMemo(
    () => MOCK_MODELS.find((model) => model.id === selectedModelId) ?? MOCK_MODELS[0],
    [selectedModelId],
  )

  const showStop = Boolean(isStreaming && onStop)
  const isReasoningActive = reasoning !== "off"

  return (
    <div className={cn("flex items-center gap-1", className)}>
      {/* Model selector */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 min-w-0 shrink gap-1 px-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <span className="max-w-28 truncate font-medium">{selectedModel.name}</span>
            <CaretDown className="size-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          {MOCK_MODELS.map((model) => (
            <DropdownMenuItem
              key={model.id}
              className={cn("flex items-center gap-2 text-xs", model.id === selectedModel.id && "bg-muted")}
              onSelect={() => setSelectedModelId(model.id)}
            >
              <span className={cn("flex-1 truncate", model.id === selectedModel.id && "font-medium")}>
                {model.name}
              </span>
              <span className="font-mono text-[10px] text-muted-foreground">{model.contextWindow}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Reasoning level */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={cn(
              "h-7 gap-1 px-1.5 text-xs",
              isReasoningActive ? "text-primary" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Brain className="size-3.5" />
            <span>{REASONING_LABELS[reasoning]}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-36">
          {REASONING_LEVELS.map((level) => (
            <DropdownMenuItem
              key={level}
              className={cn("text-xs", level === reasoning && "bg-muted font-medium")}
              onSelect={() => setReasoning(level)}
            >
              <Brain className="size-3" />
              {REASONING_LABELS[level]}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Send / Stop button */}
      <Button
        type="button"
        size="icon"
        className={cn(
          "size-8 rounded-full transition-transform hover:scale-105 active:scale-95",
          showStop && "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        )}
        disabled={!showStop && !hasContent}
        onClick={showStop ? onStop : onSend}
        aria-label={showStop ? "Stop response" : "Send message"}
      >
        {showStop ? (
          <span className="size-3 animate-pulse rounded-sm bg-current" />
        ) : (
          <ArrowUp className="size-4" weight="bold" />
        )}
      </Button>
    </div>
  )
}
