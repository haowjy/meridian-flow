import { plural, t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import type { Turn } from "@meridian/contracts/protocol";
import { Bug, Check, Copy } from "lucide-react";
import { useMemo, useState } from "react";
import { CopyTextButton } from "@/components/app/CopyTextButton";
import { IconButton } from "@/components/ui/icon-button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DEBUG_FEATURE_ALLOWED,
  openLlmCalls,
  useDebugEnabled,
} from "@/features/debug/use-debug-enabled";
import { assistantTurnCopyHtml } from "./assistant-turn-copy";
import { DeriveTurnActions } from "./derivation/DeriveTurnActions";
import { TurnInfoButton, TurnInfoRow } from "./TurnInfoButton";
import { TURN_ACTION_TOOLTIP_SIDE } from "./turn-action-tooltip";
import { cacheHitPercent, compactCount, turnStats } from "./turn-stats";

function formatPercent(locale: string, percent: number): string {
  return new Intl.NumberFormat(locale, {
    style: "percent",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(percent / 100);
}

function cacheHitValue(
  percent: number | null,
  reported: boolean,
  locale: string,
  notReported: string,
): string {
  return reported && percent != null ? formatPercent(locale, percent) : notReported;
}

function formatFixed(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value);
}

export function AssistantTurnActions({
  threadId,
  turn,
  responseParts,
  threadUsage,
  markdown,
}: {
  threadId: string;
  turn: Turn;
  responseParts: readonly Turn[];
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
  const stats = useMemo(() => turnStats(responseParts), [responseParts]);
  const threadHitPercent = threadUsage
    ? cacheHitPercent(threadUsage.cacheReadTokens, threadUsage.cacheReportedInputTokens)
    : null;
  const threadCacheReported = (threadUsage?.cacheReportedCalls ?? 0) > 0;
  const sections = [
    {
      title: i18n._(t`Thread`),
      rows: (
        <>
          {threadUsage ? (
            <TurnInfoRow
              label={i18n._(t`Cache hit`)}
              value={cacheHitValue(
                threadHitPercent,
                threadCacheReported,
                i18n.locale,
                i18n._(t`Not reported`),
              )}
              mono={threadCacheReported}
            />
          ) : null}
          {threadCacheReported ? (
            <TurnInfoRow
              label={i18n._(t`Cache resets`)}
              value={threadUsage?.cacheResets ?? 0}
              mono
            />
          ) : null}
        </>
      ),
    },
    {
      title: i18n._(t`Turn`),
      rows: (
        <>
          <TurnInfoRow
            label={i18n._(t`Model`)}
            value={stats.models.length ? stats.models.join(", ") : i18n._(t`Unknown`)}
            valueClassName="max-w-36 truncate font-medium"
            title={stats.models.join(", ") || undefined}
          />
          <TurnInfoRow
            label={i18n._(t`Calls`)}
            value={i18n._(plural(stats.callCount, { one: "# call", other: "# calls" }))}
          />
          {stats.outputTokensPerSecond == null ? null : (
            <TurnInfoRow
              label={i18n._(t`Output speed`)}
              value={i18n._(t`${compactCount(stats.outputTokensPerSecond)} tok/s`)}
              mono
            />
          )}
          {stats.ttftMs == null ? null : (
            <TurnInfoRow
              label={i18n._(t`Time to first token`)}
              value={
                stats.ttftMs < 100
                  ? i18n._(t`<0.1 s`)
                  : i18n._(t`${formatFixed(stats.ttftMs / 1000, i18n.locale)} s`)
              }
              mono
            />
          )}
          <TurnInfoRow
            label={i18n._(t`Input tokens`)}
            value={compactCount(stats.inputTokens)}
            mono
          />
          <TurnInfoRow
            label={i18n._(t`Output tokens`)}
            value={compactCount(stats.outputTokens)}
            mono
          />
          {stats.callCount > 0 &&
          (stats.cacheReportedCalls === 0 || stats.cacheHitPercent != null) ? (
            <TurnInfoRow
              label={i18n._(t`Cache hit`)}
              value={cacheHitValue(
                stats.cacheHitPercent,
                stats.cacheReportedCalls > 0,
                i18n.locale,
                i18n._(t`Not reported`),
              )}
              mono={stats.cacheReportedCalls > 0}
            />
          ) : null}
          {stats.cacheResets > 0 ? (
            <TurnInfoRow label={i18n._(t`Cache resets`)} value={stats.cacheResets} mono />
          ) : null}
        </>
      ),
    },
  ];
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
            aria-label={copyLabel}
            copiedLabel={copiedLabel}
            copiedContent={<Check aria-hidden />}
            onCopiedChange={setCopied}
            disabled={!markdown}
          >
            <Copy aria-hidden />
          </CopyTextButton>
        </TooltipTrigger>
        <TooltipContent side={TURN_ACTION_TOOLTIP_SIDE}>
          {copied ? copiedLabel : copyLabel}
        </TooltipContent>
      </Tooltip>
      <DeriveTurnActions turnId={turn.id} />
      {stats.callCount > 0 ? (
        <TurnInfoButton label={i18n._(t`Turn information`)} sections={sections} />
      ) : null}
      {DEBUG_FEATURE_ALLOWED && enabled ? (
        <IconButton
          type="button"
          tooltip="Inspect model calls"
          tooltipSide={TURN_ACTION_TOOLTIP_SIDE}
          onClick={() =>
            openLlmCalls(
              responseParts.length > 1
                ? { threadId, turnIds: responseParts.map((part) => part.id) }
                : { threadId, turnId: turn.id },
            )
          }
        >
          <Bug aria-hidden />
        </IconButton>
      ) : null}
    </div>
  );
}
