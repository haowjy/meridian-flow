import type { ReactNode } from 'react'
import { ArrowUp, Brain, Check, ChevronDown, StopCircle, Wrench } from 'lucide-react'
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
import { SimpleTooltip } from '@/shared/components/ui/tooltip'
import type { ThreadRequestOptions, ReasoningLevel } from '@/features/threads/types'
import { DEFAULT_THREAD_REQUEST_OPTIONS } from '@/features/threads/types'
import { useModelCapabilities } from '@/features/threads/hooks/useModelCapabilities'

interface ThreadRequestControlsProps {
  options: ThreadRequestOptions
  onOptionsChange: (options: ThreadRequestOptions) => void
  onSend?: () => void
  isSendDisabled?: boolean
  rightContent?: ReactNode
  isStreaming?: boolean
  onStop?: () => void
  /** When false, hides the send/stop button area (useful for compact mobile composer). */
  showSend?: boolean
  /** When true, show Check icon instead of ArrowUp (for edit/save vs send). */
  saveIcon?: boolean
}

export function ThreadRequestControls({
  options,
  onOptionsChange,
  onSend,
  isSendDisabled,
  rightContent,
  isStreaming,
  onStop,
  showSend = true,
  saveIcon = false,
}: ThreadRequestControlsProps) {
  const { providers } = useModelCapabilities()

  const allModels =
    providers.flatMap((provider) =>
      provider.models.map((model) => ({
        providerId: provider.id,
        providerName: provider.name,
        id: model.id,
        displayName: model.displayName,
        contextWindow: model.contextWindow,
        supportsThinking: model.supportsThinking,
        requiresThinking: model.requiresThinking,
        supportsTools: model.supportsTools,
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
    modelSupportsTools: boolean,
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
      supportsTools: modelSupportsTools,
    })
  }

  const showStop = Boolean(isStreaming && onStop)

  return (
    <div className="flex items-center gap-2 pt-1 text-xs">
      <div className="@container flex flex-1 items-center gap-1">
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
      {isStreaming && (
        <span className="size-1.5 animate-pulse rounded-full bg-primary" />
      )}
      {showSend && (onSend || rightContent) && (
        <div className="flex items-center gap-1">
          {rightContent}
          {onSend && (
            <Button
              type="button"
              size="icon-lg"
              className="transition-transform hover:scale-105 active:scale-95 disabled:hover:scale-100"
              disabled={showStop ? false : isSendDisabled}
              onClick={showStop && onStop ? onStop : onSend}
              aria-label={showStop ? 'Stop response' : saveIcon ? 'Save' : 'Send message'}
            >
              {showStop ? <StopCircle /> : saveIcon ? <Check /> : <ArrowUp />}
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
    contextWindow: number
    supportsThinking: boolean
    requiresThinking: boolean
    supportsTools: boolean
  }[]
  selectedModelId: string
  modelLabel: string
  onSelectModel: (
    modelId: string,
    modelLabel: string,
    providerId: string,
    supportsThinking: boolean,
    requiresThinking: boolean,
    supportsTools: boolean,
  ) => void
}

/** Format context window tokens as human-readable string (e.g., 200K, 1M) */
function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 1_000_000)}M`
  return `${Math.round(tokens / 1_000)}K`
}

function ModelSelector({
  models,
  selectedModelId,
  modelLabel,
  onSelectModel,
}: ModelSelectorProps) {
  // Look up proper display name (modelLabel may be the raw model ID from backend)
  const selectedModel = models.find((m) => m.id === selectedModelId)
  const displayLabel = selectedModel?.displayName ?? modelLabel

  const grouped = models.reduce<
    Record<
      string,
      {
        providerName: string
        items: {
          id: string
          displayName: string
          contextWindow: number
          supportsThinking: boolean
          requiresThinking: boolean
          supportsTools: boolean
        }[]
      }
    >
  >((acc, model) => {
    const key = model.providerId
    if (!acc[key]) {
      acc[key] = { providerName: model.providerName, items: [] }
    }
    acc[key].items.push({
      id: model.id,
      displayName: model.displayName,
      contextWindow: model.contextWindow,
      supportsThinking: model.supportsThinking,
      requiresThinking: model.requiresThinking,
      supportsTools: model.supportsTools,
    })
    return acc
  }, {})

  const groups = Object.entries(grouped)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="min-w-0 !shrink px-1.5 text-muted-foreground hover:text-foreground"
        >
          <span className="max-w-24 truncate font-medium">{displayLabel}</span>
          <ChevronDown className="shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {groups.length === 0 && (
          <DropdownMenuItem
            onSelect={() =>
              onSelectModel(
                DEFAULT_THREAD_REQUEST_OPTIONS.modelId,
                DEFAULT_THREAD_REQUEST_OPTIONS.modelLabel,
                DEFAULT_THREAD_REQUEST_OPTIONS.providerId,
                true, // default model supports thinking
                true, // default model requires thinking (kimi-k2-thinking)
                DEFAULT_THREAD_REQUEST_OPTIONS.supportsTools, // default model supports tools
              )
            }
            className="text-xs"
          >
            {DEFAULT_THREAD_REQUEST_OPTIONS.modelLabel}
          </DropdownMenuItem>
        )}
        {groups.map(([providerId, group], index) => (
          <div key={providerId}>
            <DropdownMenuLabel className="mt-1 text-[10px] font-normal text-muted-foreground sm:text-xs">
              {group.providerName}
            </DropdownMenuLabel>
            {group.items.map((model) => (
              <DropdownMenuItem
                key={model.id}
                className={cn(
                  "flex items-center gap-2 text-xs",
                  model.id === selectedModelId && "bg-muted"
                )}
                onSelect={() =>
                  onSelectModel(model.id, model.displayName, providerId, model.supportsThinking, model.requiresThinking, model.supportsTools)
                }
              >
                <span
                  className={cn(
                    "flex-1",
                    model.id === selectedModelId ? "font-medium" : undefined,
                    !model.supportsTools && "text-muted-foreground"
                  )}
                >
                  {model.displayName}
                </span>
                <SimpleTooltip content="Context window" side="top">
                  <span className="w-10 text-right font-mono text-[10px] text-muted-foreground">
                    {formatContext(model.contextWindow)}
                  </span>
                </SimpleTooltip>
                <div className="flex w-8 justify-end gap-1">
                  {model.requiresThinking && (
                    <SimpleTooltip content="Thinking" side="top">
                      <span className="inline-flex">
                        <Brain className="size-3 text-muted-foreground" />
                      </span>
                    </SimpleTooltip>
                  )}
                  {model.supportsTools && (
                    <SimpleTooltip content="Tools" side="top">
                      <span className="inline-flex">
                        <Wrench className="size-3 text-muted-foreground" />
                      </span>
                    </SimpleTooltip>
                  )}
                </div>
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
          size="xs"
          variant="ghost"
          disabled={disabled}
          className={cn(
            "px-1.5",
            isActive ? "text-primary" : "text-muted-foreground hover:text-foreground",
            disabled && "opacity-50"
          )}
        >
          <Brain />
          <span className="hidden @[200px]:inline">{REASONING_LABELS[value]}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {levels.map((level) => (
          <DropdownMenuItem
            key={level}
            onSelect={() => onChange(level)}
            className="flex items-center gap-2 text-xs"
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
