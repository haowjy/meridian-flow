import { plural, t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import type { Turn } from "@meridian/contracts/protocol";
import { Bug, Check, Copy, Info } from "lucide-react";
import type { ReactNode } from "react";
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

function StatRow({
  label,
  value,
  mono = false,
  valueClassName,
  title,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
  valueClassName?: string;
  title?: string;
}) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={`text-right ${mono ? "font-mono" : ""} ${valueClassName ?? ""}`} title={title}>
        {value}
      </dd>
    </>
  );
}

function StatSection({
  title,
  children,
  separated,
}: {
  title: string;
  children: ReactNode;
  separated: boolean;
}) {
  return (
    <>
      <dt
        className={`col-span-2 font-medium text-foreground ${
          separated
            ? "mt-[var(--chat-space-row)] border-t border-border pt-[var(--chat-space-row)]"
            : ""
        }`}
      >
        {title}
      </dt>
      {children}
    </>
  );
}

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
  const threadCacheReported = (threadUsage?.cacheReportedCalls ?? 0) > 0;
  const sections = [
    {
      title: i18n._(t`Thread`),
      rows: (
        <>
          {threadUsage ? (
            <StatRow
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
            <StatRow label={i18n._(t`Cache resets`)} value={threadUsage?.cacheResets ?? 0} mono />
          ) : null}
        </>
      ),
    },
    {
      title: i18n._(t`Turn`),
      rows: (
        <>
          <StatRow
            label={i18n._(t`Model`)}
            value={stats.model ?? i18n._(t`Unknown`)}
            valueClassName="max-w-36 truncate font-medium"
            title={stats.model ?? undefined}
          />
          <StatRow
            label={i18n._(t`Calls`)}
            value={i18n._(plural(stats.callCount, { one: "# call", other: "# calls" }))}
          />
          {stats.outputTokensPerSecond == null ? null : (
            <StatRow
              label={i18n._(t`Output speed`)}
              value={i18n._(t`${compactCount(stats.outputTokensPerSecond)} tok/s`)}
              mono
            />
          )}
          {stats.ttftMs == null ? null : (
            <StatRow
              label={i18n._(t`Time to first token`)}
              value={
                stats.ttftMs < 100
                  ? i18n._(t`<0.1 s`)
                  : i18n._(t`${formatFixed(stats.ttftMs / 1000, i18n.locale)} s`)
              }
              mono
            />
          )}
          <StatRow label={i18n._(t`Input tokens`)} value={compactCount(stats.inputTokens)} mono />
          <StatRow label={i18n._(t`Output tokens`)} value={compactCount(stats.outputTokens)} mono />
          {stats.callCount > 0 &&
          (stats.cacheReportedCalls === 0 || stats.cacheHitPercent != null) ? (
            <StatRow
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
            <StatRow label={i18n._(t`Cache resets`)} value={stats.cacheResets} mono />
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
              {sections.map(({ title, rows }, index) => (
                <StatSection key={title} title={title} separated={index > 0}>
                  {rows}
                </StatSection>
              ))}
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
