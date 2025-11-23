"use client"

import type { ReactNode } from 'react'
import { Brain, ChevronDown, Globe2, Send, StopCircle } from 'lucide-react'
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

  const isAnthropic = options.providerId === 'anthropic'
  const canToggleSearch = isAnthropic

  const allModels =
    providers.flatMap((provider) =>
      provider.models.map((model) => ({
        providerId: provider.id,
        providerName: provider.name,
        id: model.id,
        displayName: model.displayName,
        supportsThinking: model.supportsThinking,
      })),
    ) ?? []

  const handleSelectModel = (
    modelId: string,
    modelLabel: string,
    providerId: string,
  ) => {
    const isAnthropicProvider = providerId === 'anthropic'

    onOptionsChange({
      ...options,
      modelId,
      modelLabel,
      providerId,
      // Hard-disable search when switching away from Anthropic
      searchEnabled: isAnthropicProvider ? options.searchEnabled : false,
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
        />
        <WebSearchToggle
          enabled={options.searchEnabled}
          disabled={!canToggleSearch}
          onToggle={() =>
            onOptionsChange({
              ...options,
              searchEnabled: !options.searchEnabled,
            })
          }
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
              {showStop ? <StopCircle className="size-4" /> : <Send className="size-4" />}
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
  }[]
  selectedModelId: string
  modelLabel: string
  onSelectModel: (
    modelId: string,
    modelLabel: string,
    providerId: string,
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
      { providerName: string; items: { id: string; displayName: string }[] }
    >
  >((acc, model) => {
    const key = model.providerId
    if (!acc[key]) {
      acc[key] = { providerName: model.providerName, items: [] }
    }
    acc[key].items.push({ id: model.id, displayName: model.displayName })
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
        <DropdownMenuLabel className="text-[0.7rem] sm:text-xs">
          Models
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {groups.length === 0 && (
          <DropdownMenuItem
            onSelect={() =>
              onSelectModel(
                DEFAULT_MODEL_ID,
                DEFAULT_MODEL_LABEL,
                DEFAULT_PROVIDER_ID,
              )
            }
            className="text-[0.7rem] sm:text-xs"
          >
            {DEFAULT_MODEL_LABEL}
          </DropdownMenuItem>
        )}
        {groups.map(([providerId, group]) => (
          <div key={providerId}>
            <DropdownMenuLabel className="mt-1 text-[0.65rem] font-normal text-muted-foreground sm:text-[0.7rem]">
              {group.providerName}
            </DropdownMenuLabel>
            {group.items.map((model) => (
              <DropdownMenuItem
                key={model.id}
                className="flex items-center gap-2 text-[0.7rem] sm:text-xs"
                onSelect={() =>
                  onSelectModel(model.id, model.displayName, providerId)
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
            <DropdownMenuSeparator />
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const REASONING_LABELS: Record<ReasoningLevel, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
}

interface ReasoningDropdownProps {
  value: ReasoningLevel
  onChange: (value: ReasoningLevel) => void
}

function ReasoningDropdown({
  value,
  onChange,
}: ReasoningDropdownProps) {
  const levels: ReasoningLevel[] = ['low', 'medium', 'high']

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="flex items-center gap-1 px-1.5 py-1 text-[0.7rem] sm:text-xs"
        >
          <Brain className="size-3" />
          <span>{REASONING_LABELS[value]}</span>
          <ChevronDown className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel className="text-[0.7rem] sm:text-xs">
          Reasoning
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {levels.map((level) => (
          <DropdownMenuItem
            key={level}
            onSelect={() => onChange(level)}
            className="flex items-center gap-2 text-[0.7rem] sm:text-xs"
          >
            <Brain className="size-3" />
            <span>{REASONING_LABELS[level]}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

interface WebSearchToggleProps {
  enabled: boolean
  disabled: boolean
  onToggle: () => void
}

function WebSearchToggle({
  enabled,
  disabled,
  onToggle,
}: WebSearchToggleProps) {
  const variant = enabled ? 'default' : 'outline'

  return (
    <Button
      type="button"
      size="sm"
      variant={variant}
      disabled={disabled}
      className="flex items-center gap-1 px-1.5 py-1 text-[0.7rem] sm:text-xs"
      onClick={onToggle}
    >
      <Globe2 className="size-3" />
      Search
    </Button>
  )
}
