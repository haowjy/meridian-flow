import type { ReactNode } from 'react'
import { ArrowUp, Brain, ChevronDown, StopCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/shared/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/shared/components/ui/dropdown-menu'
import type { ChatRequestOptions, ReasoningLevel } from '@/features/chats/types'
import { useModelCapabilities } from '@/features/chats/hooks/useModelCapabilities'

const DEFAULT_MODEL_ID = 'moonshotai/kimi-k2-thinking'
const DEFAULT_MODEL_LABEL = 'Kimi K2 Thinking'
const DEFAULT_PROVIDER_ID = 'openrouter'

interface ChatRequestControlsProps {
  options: ChatRequestOptions
  onOptionsChange: (options: ChatRequestOptions) => void
  onSend?: () => void
  isSendDisabled?: boolean
  rightContent?: ReactNode
  isStreaming?: boolean
  onStop?: () => void
}

export function ChatRequestControls({
  options,
  onOptionsChange,
  onSend,
  isSendDisabled,
  rightContent,
  isStreaming,
  onStop,
}: ChatRequestControlsProps) {
  const { providers } = useModelCapabilities()

  const allModels =
    providers.flatMap((provider) =>
      provider.models.map((model) => ({
        providerId: provider.id,
        providerName: provider.name,
        id: model.id,
        displayName: model.displayName,
        supportsThinking: model.supportsThinking,
        requiresThinking: model.requiresThinking,
      })),
    ) ?? []

  // Find the selected model to check thinking capabilities
  const selectedModel = allModels.find((m) => m.id === options.modelId)
  const supportsThinking = selectedModel?.supportsThinking ?? true
  const requiresThinking = selectedModel?.requiresThinking ?? false

  const handleSelectModel = (
    modelId: string,
    modelLabel: string,
    providerId: string,
    modelSupportsThinking: boolean,
    modelRequiresThinking: boolean,
  ) => {
    // Determine appropriate reasoning level based on model capabilities
    let reasoning = options.reasoning
    if (!modelSupportsThinking) {
      // Model doesn't support thinking - force to 'off'
      reasoning = 'off'
    } else if (modelRequiresThinking && options.reasoning === 'off') {
      // Model requires thinking but current is 'off' - set to 'low'
      reasoning = 'low'
    }

    onOptionsChange({
      ...options,
      modelId,
      modelLabel,
      providerId,
      reasoning,
    })
  }

  const showStop = Boolean(isStreaming && onStop)

  return (
    <div className="flex items-center gap-2 pt-1 text-[0.7rem] sm:text-xs">
      <div className="flex flex-1 flex-wrap items-center gap-2">
        <ModelSelector
          models={allModels}
          selectedModelId={options.modelId}
          modelLabel={options.modelLabel}
          onSelectModel={handleSelectModel}
        />
        <ReasoningDropdown
          value={options.reasoning}
          onChange={(reasoning) =>
            onOptionsChange({ ...options, reasoning })
          }
          disabled={!supportsThinking}
          requiresThinking={requiresThinking}
        />
      </div>
      {(onSend || rightContent) && (
        <div className="flex items-center gap-1">
          {rightContent}
          {onSend && (
            <Button
              type="button"
              size="icon"
              className="shrink-0 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0"
              disabled={showStop ? false : isSendDisabled}
              onClick={showStop && onStop ? onStop : onSend}
              aria-label={showStop ? 'Stop response' : 'Send message'}
            >
              {showStop ? <StopCircle className="size-4" /> : <ArrowUp className="size-4" />}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

interface ModelSelectorProps {
  models: {
    providerId: string
    providerName: string
    id: string
    displayName: string
    supportsThinking: boolean
    requiresThinking: boolean
  }[]
  selectedModelId: string
  modelLabel: string
  onSelectModel: (
    modelId: string,
    modelLabel: string,
    providerId: string,
    supportsThinking: boolean,
    requiresThinking: boolean,
  ) => void
}

function ModelSelector({
  models,
  selectedModelId,
  modelLabel,
  onSelectModel,
}: ModelSelectorProps) {
  const grouped = models.reduce<
    Record<
      string,
      { providerName: string; items: { id: string; displayName: string; supportsThinking: boolean; requiresThinking: boolean }[] }
    >
  >((acc, model) => {
    const key = model.providerId
    if (!acc[key]) {
      acc[key] = { providerName: model.providerName, items: [] }
    }
    acc[key].items.push({ id: model.id, displayName: model.displayName, supportsThinking: model.supportsThinking, requiresThinking: model.requiresThinking })
    return acc
  }, {})

  const groups = Object.entries(grouped)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="flex items-center gap-1 px-2 py-1 text-[0.7rem] sm:text-xs"
        >
          <span className="font-medium">{modelLabel}</span>
          <ChevronDown className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {groups.length === 0 && (
          <DropdownMenuItem
            onSelect={() =>
              onSelectModel(
                DEFAULT_MODEL_ID,
                DEFAULT_MODEL_LABEL,
                DEFAULT_PROVIDER_ID,
                true, // default model supports thinking
                true, // default model requires thinking (kimi-k2-thinking)
              )
            }
            className="text-[0.7rem] sm:text-xs"
          >
            {DEFAULT_MODEL_LABEL}
          </DropdownMenuItem>
        )}
        {groups.map(([providerId, group], index) => (
          <div key={providerId}>
            <DropdownMenuLabel className="mt-1 text-[0.65rem] font-normal text-muted-foreground sm:text-[0.7rem]">
              {group.providerName}
            </DropdownMenuLabel>
            {group.items.map((model) => (
              <DropdownMenuItem
                key={model.id}
                className="flex items-center gap-2 text-[0.7rem] sm:text-xs"
                onSelect={() =>
                  onSelectModel(model.id, model.displayName, providerId, model.supportsThinking, model.requiresThinking)
                }
              >
                <span
                  className={
                    model.id === selectedModelId
                      ? 'font-medium'
                      : undefined
                  }
                >
                  {model.displayName}
                </span>
              </DropdownMenuItem>
            ))}
            {index < groups.length - 1 && <DropdownMenuSeparator />}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const REASONING_LABELS: Record<ReasoningLevel, string> = {
  off: 'Off',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
}

interface ReasoningDropdownProps {
  value: ReasoningLevel
  onChange: (value: ReasoningLevel) => void
  /** When true, dropdown is disabled (model doesn't support thinking) */
  disabled?: boolean
  /** When true, "Off" option is hidden (model requires thinking) */
  requiresThinking?: boolean
}

function ReasoningDropdown({
  value,
  onChange,
  disabled = false,
  requiresThinking = false,
}: ReasoningDropdownProps) {
  // Filter out "off" option if model requires thinking
  const levels: ReasoningLevel[] = requiresThinking
    ? ['low', 'medium', 'high']
    : ['off', 'low', 'medium', 'high']
  const isActive = value !== 'off'

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          className={cn(
            "flex items-center gap-1 px-2 py-1 text-[0.7rem] sm:text-xs",
            // Off state: white/card background to blend with message input
            !isActive && "bg-card",
            // Active state: subtle jade background tint
            isActive && "bg-primary/10",
            // Disabled state: muted appearance
            disabled && "text-muted-foreground opacity-50"
          )}
        >
          <Brain className="size-3" />
          <span>{REASONING_LABELS[value]}</span>
          <ChevronDown className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {levels.map((level) => (
          <DropdownMenuItem
            key={level}
            onSelect={() => onChange(level)}
            className="flex items-center gap-2 text-[0.7rem] sm:text-xs"
          >
            <Brain className="size-3" />
            <span className={value === level ? 'font-medium' : undefined}>
              {REASONING_LABELS[level]}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

