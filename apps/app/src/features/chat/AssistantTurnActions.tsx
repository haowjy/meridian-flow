import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import type { Turn } from "@meridian/contracts/protocol";
import { Bug, Copy, Info } from "lucide-react";
import { CopyTextButton } from "@/components/app/CopyTextButton";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { DEBUG_FEATURE_ALLOWED, useDebugEnabled } from "@/features/debug/use-debug-enabled";
import { partitionTurn } from "./partition-turn";
import { payloadText } from "./ReportContent";
import { compactCount, turnStats } from "./turn-stats";

const actionClass = "size-6 text-muted-foreground";

export function AssistantTurnActions({ threadId, turn }: { threadId: string; turn: Turn }) {
  const { i18n } = useLingui();
  const { enabled } = useDebugEnabled();
  const stats = turnStats(turn);
  const answer = partitionTurn([...turn.blocks].sort((a, b) => a.sequence - b.sequence))
    .flatMap((item) => {
      if (item.kind === "text") return [item.block.textContent ?? ""];
      if (item.kind === "report") {
        return [item.report.summary, payloadText(item.report.payload)].filter((part) =>
          part.trim(),
        );
      }
      return [];
    })
    .filter((text) => text.trim().length > 0)
    .join("\n\n");

  return (
    <TooltipProvider>
      <div
        className="assistant-turn-actions flex min-h-6 items-center gap-1 transition-opacity"
        data-assistant-turn-actions
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <CopyTextButton
              text={answer}
              variant="quiet"
              size="icon-xs"
              className={actionClass}
              aria-label={i18n._(t`Copy answer`)}
              title={i18n._(t`Copy answer`)}
              disabled={!answer}
            >
              <Copy aria-hidden />
            </CopyTextButton>
          </TooltipTrigger>
          <TooltipContent>{i18n._(t`Copy answer`)}</TooltipContent>
        </Tooltip>
        <Popover>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Button
                  variant="quiet"
                  size="icon-xs"
                  className={actionClass}
                  aria-label={i18n._(t`Turn information`)}
                >
                  <Info aria-hidden />
                </Button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent>{i18n._(t`Turn information`)}</TooltipContent>
          </Tooltip>
          <PopoverContent align="start" className="w-64 p-3">
            <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-xs">
              <dt className="text-muted-foreground">{i18n._(t`Model`)}</dt>
              <dd
                className="max-w-36 truncate text-right font-medium"
                title={stats.model ?? undefined}
              >
                {stats.model ?? i18n._(t`Unknown`)}
                {stats.callCount > 1 ? ` (${stats.callCount})` : ""}
              </dd>
              <dt className="text-muted-foreground">{i18n._(t`Output speed`)}</dt>
              <dd className="text-right font-mono">
                {stats.outputTokensPerSecond == null
                  ? i18n._(t`Unavailable`)
                  : i18n._(t`${compactCount(stats.outputTokensPerSecond)} tok/s`)}
              </dd>
              <dt className="text-muted-foreground">{i18n._(t`Time to first token`)}</dt>
              <dd className="text-right font-mono">
                {stats.ttftMs == null
                  ? i18n._(t`Unavailable`)
                  : i18n._(t`${compactCount(stats.ttftMs)} ms`)}
              </dd>
              <dt className="text-muted-foreground">{i18n._(t`Input tokens`)}</dt>
              <dd className="text-right font-mono">{compactCount(stats.inputTokens)}</dd>
              <dt className="text-muted-foreground">{i18n._(t`Output tokens`)}</dt>
              <dd className="text-right font-mono">{compactCount(stats.outputTokens)}</dd>
              <dt className="text-muted-foreground">{i18n._(t`Cache hit`)}</dt>
              <dd className="text-right font-mono">
                {stats.cacheHitPercent == null
                  ? i18n._(t`Unavailable`)
                  : `${stats.cacheHitPercent.toFixed(1)}%`}
              </dd>
            </dl>
          </PopoverContent>
        </Popover>
        {DEBUG_FEATURE_ALLOWED && enabled ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="quiet"
                size="icon-xs"
                className={actionClass}
                aria-label={i18n._(t`Inspect model calls`)}
                onClick={() =>
                  window.dispatchEvent(
                    new CustomEvent("meridian:debug-open-llm-calls", {
                      detail: { threadId, turnId: turn.id },
                    }),
                  )
                }
              >
                <Bug aria-hidden />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{i18n._(t`Inspect model calls`)}</TooltipContent>
          </Tooltip>
        ) : null}
      </div>
    </TooltipProvider>
  );
}
