import { plural, t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import type { Turn } from "@meridian/contracts/protocol";
import { Bug, Check, Copy, Info } from "lucide-react";
import { useState } from "react";
import { CopyTextButton } from "@/components/app/CopyTextButton";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DEBUG_FEATURE_ALLOWED,
  openLlmCalls,
  useDebugEnabled,
} from "@/features/debug/use-debug-enabled";
import { assistantTurnCopyHtml } from "./assistant-turn-copy";
import { cacheHitPercent, compactCount, turnStats } from "./turn-stats";

const actionClass = "size-6 text-muted-foreground";

export function AssistantTurnActions({
  threadId,
  turn,
  threadUsage,
  markdown,
}: {
  threadId: string;
  turn: Turn;
  threadUsage: {
    inputTokens: number;
    cacheReadTokens: number;
    cacheReportedInputTokens: number;
    cacheReportedCalls: number;
    cacheWriteTokens: number;
    outputTokens: number;
    cacheResets: number;
  } | null;
  markdown: string;
}) {
  const { i18n } = useLingui();
  const { enabled } = useDebugEnabled();
  const [copied, setCopied] = useState(false);
  const stats = turnStats(turn);
  const threadHitPercent = threadUsage
    ? cacheHitPercent(threadUsage.cacheReadTokens, threadUsage.cacheReportedInputTokens)
    : null;
  const copyLabel = i18n._(t`Copy`);
  const copiedLabel = i18n._(t`Copied`);

  return (
    <div
      className="assistant-turn-actions mt-[var(--chat-space-inline)] flex min-h-6 items-center gap-[var(--chat-space-inline)] transition-opacity"
      data-assistant-turn-actions
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <CopyTextButton
            text={markdown}
            html={() => assistantTurnCopyHtml(markdown)}
            variant="quiet"
            size="icon-xs"
            className={actionClass}
            aria-label={copyLabel}
            copiedLabel={copiedLabel}
            copiedContent={<Check aria-hidden />}
            onCopiedChange={setCopied}
            disabled={!markdown}
          >
            <Copy aria-hidden />
          </CopyTextButton>
        </TooltipTrigger>
        <TooltipContent>{copied ? copiedLabel : copyLabel}</TooltipContent>
      </Tooltip>
      {stats.callCount > 0 ? (
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
          <PopoverContent align="start" className="text-tier-chat chat-card w-64">
            <dl className="grid grid-cols-[1fr_auto] gap-x-[var(--chat-space-block)] gap-y-[var(--chat-space-row)] text-xs">
              <dt className="col-span-2 mt-[var(--chat-space-row)] border-t border-border pt-[var(--chat-space-row)] font-medium text-foreground">
                {i18n._(t`Thread`)}
              </dt>
              {threadUsage?.cacheReportedCalls === 0 ? (
                <>
                  <dt className="text-muted-foreground">{i18n._(t`Thread cache hit`)}</dt>
                  <dd className="text-right">{i18n._(t`Not reported`)}</dd>
                </>
              ) : threadHitPercent != null ? (
                <>
                  <dt className="text-muted-foreground">{i18n._(t`Thread cache hit`)}</dt>
                  <dd className="text-right font-mono">{threadHitPercent.toFixed(1)}%</dd>
                </>
              ) : null}
              {threadUsage && threadUsage.cacheResets > 0 ? (
                <>
                  <dt className="text-muted-foreground">{i18n._(t`Cache resets`)}</dt>
                  <dd className="text-right font-mono">{threadUsage.cacheResets}</dd>
                </>
              ) : null}
              <dt className="col-span-2 mt-[var(--chat-space-row)] border-t border-border pt-[var(--chat-space-row)] font-medium text-foreground">
                {i18n._(t`Turn`)}
              </dt>
              <dt className="text-muted-foreground">{i18n._(t`Model`)}</dt>
              <dd
                className="max-w-36 truncate text-right font-medium"
                title={stats.model ?? undefined}
              >
                {stats.model ?? i18n._(t`Unknown`)}
              </dd>
              <dt className="text-muted-foreground">{i18n._(t`Calls`)}</dt>
              <dd className="text-right">
                {i18n._(plural(stats.callCount, { one: "# call", other: "# calls" }))}
              </dd>
              {stats.outputTokensPerSecond == null ? null : (
                <>
                  <dt className="text-muted-foreground">{i18n._(t`Output speed`)}</dt>
                  <dd className="text-right font-mono">
                    {i18n._(t`${compactCount(stats.outputTokensPerSecond)} tok/s`)}
                  </dd>
                </>
              )}
              {stats.ttftMs == null ? null : (
                <>
                  <dt className="text-muted-foreground">{i18n._(t`Time to first token`)}</dt>
                  <dd className="text-right font-mono">
                    {stats.ttftMs < 100
                      ? i18n._(t`<0.1 s`)
                      : i18n._(
                          t`${new Intl.NumberFormat(i18n.locale, {
                            minimumFractionDigits: 1,
                            maximumFractionDigits: 1,
                          }).format(stats.ttftMs / 1000)} s`,
                        )}
                  </dd>
                </>
              )}
              <dt className="text-muted-foreground">{i18n._(t`Input tokens`)}</dt>
              <dd className="text-right font-mono">{compactCount(stats.inputTokens)}</dd>
              <dt className="text-muted-foreground">{i18n._(t`Output tokens`)}</dt>
              <dd className="text-right font-mono">{compactCount(stats.outputTokens)}</dd>
              {stats.callCount > 0 && stats.cacheReportedCalls === 0 ? (
                <>
                  <dt className="text-muted-foreground">{i18n._(t`Turn cache hit`)}</dt>
                  <dd className="text-right">{i18n._(t`Not reported`)}</dd>
                </>
              ) : stats.cacheHitPercent != null ? (
                <>
                  <dt className="text-muted-foreground">{i18n._(t`Turn cache hit`)}</dt>
                  <dd className="text-right font-mono">{stats.cacheHitPercent.toFixed(1)}%</dd>
                </>
              ) : null}
              {stats.cacheResets > 0 ? (
                <>
                  <dt className="text-muted-foreground">{i18n._(t`Cache reset`)}</dt>
                  <dd className="text-right font-mono">{stats.cacheResets}</dd>
                </>
              ) : null}
            </dl>
          </PopoverContent>
        </Popover>
      ) : null}
      {DEBUG_FEATURE_ALLOWED && enabled ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="quiet"
              size="icon-xs"
              className={actionClass}
              aria-label="Inspect model calls"
              onClick={() => openLlmCalls({ threadId, turnId: turn.id })}
            >
              <Bug aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Inspect model calls</TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
}
