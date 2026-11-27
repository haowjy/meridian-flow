import { i18n } from "@lingui/core";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { Turn } from "@meridian/contracts/protocol";
import { BookOpen, FoldVertical } from "lucide-react";
import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useStatsForNerds } from "@/hooks/use-stats-for-nerds";
import { cn } from "@/lib/utils";
import { Markdown } from "@/rich-content/Markdown";
import { ActivityRow } from "../ActivityRow";
import { AnchoredCards } from "../ChatCards";
import { ClippedProse } from "../ClippedExpand";
import { CommandTitle } from "../CommandTitle";
import { DocumentName } from "../DocumentName";
import { ForkTurnAction } from "../derivation/DeriveTurnActions";
import { TurnInfoButton, TurnInfoRow } from "../TurnInfoButton";
import { CompactionInstructions } from "./CompactionInstructions";
import { type DividerDocument, type DividerView, dividerView } from "./compaction-model";
import { useFocusWithinRow } from "./useFocusWithinRow";

export type CompactionDividerProps = {
  turn: Turn;
  stopping: boolean;
  onStop?: (turnId: string) => void;
};

type StateLabel = {
  full: string;
  short: string;
};

function stateLabel(view: DividerView, stopping: boolean): StateLabel {
  const same = (label: string) => ({ full: label, short: label });
  switch (view.state) {
    case "pending":
      if (stopping) return { full: t`Stopping compaction`, short: t`Stopping` };
      return { full: t`Compacting conversation`, short: t`Compacting` };
    case "complete":
      return view.trigger === "manual"
        ? { full: t`Conversation compacted`, short: t`Compacted` }
        : { full: t`Conversation compacted automatically`, short: t`Compacted` };
    case "failed":
      return same(t`Compaction`);
    case "cancelled":
      return same(t`Compaction stopped`);
  }
}

export function CompactionDivider({ turn, stopping, onStop }: CompactionDividerProps) {
  const view = dividerView(turn);
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const sectionRef = useRef<HTMLElement>(null);
  const focusWithin = useFocusWithinRow(sectionRef);
  const label = stateLabel(view, stopping);
  const { full } = label;

  return (
    <section
      ref={sectionRef}
      tabIndex={-1}
      {...focusWithin}
      data-compaction-divider
      data-compaction-state={view.state}
      data-compaction-trigger={view.trigger}
      aria-label={view.summary ? undefined : full}
      className="@container/divider flex flex-col gap-[var(--chat-space-inline)] py-[var(--chat-space-block)] outline-none"
    >
      <div className="flex min-w-0 items-center gap-[var(--chat-space-block)]">
        {view.summary ? (
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            aria-controls={panelId}
            aria-label={t`${full}, summary`}
            data-focus-landing
            className="focus-ring focus-ring-outside flex min-w-0 items-center gap-[var(--chat-space-block)] rounded-md py-1 text-muted-foreground transition-colors hover:text-foreground aria-expanded:text-foreground motion-reduce:transition-none"
          >
            <DividerMark state={view.state} />
            <DividerLabel label={label} className="text-inherit" />
          </button>
        ) : (
          <span className="flex min-w-0 items-center gap-[var(--chat-space-block)]">
            <DividerMark state={view.state} />
            <DividerLabel label={label} className="text-muted-foreground" />
          </span>
        )}

        {view.state === "pending" && onStop ? (
          <Button
            type="button"
            variant="quiet"
            size="meta"
            // aria-disabled, not disabled: disabling the focused button would
            // drop keyboard focus to the page.
            aria-disabled={stopping || undefined}
            aria-label={t`Stop compaction`}
            onClick={() => {
              if (!stopping) onStop(turn.id);
            }}
          >
            <Trans>Stop</Trans>
          </Button>
        ) : null}

        {view.state === "complete" ? (
          <span
            data-compaction-actions
            className="compaction-divider-actions flex shrink-0 transition-opacity"
          >
            <ForkTurnAction turnId={turn.id} />
            <CompactionInfo view={view} />
          </span>
        ) : null}

        <DividerRule />
      </div>

      {view.instructions ? <CompactionInstructions instructions={view.instructions} /> : null}

      <AnchoredCards anchor={{ turn: turn.id }} />

      {view.summary || view.documents.length > 0 ? (
        <div id={panelId} hidden={!open} data-compaction-body className="flex flex-col">
          {view.summary ? (
            <div
              data-compaction-summary
              className="flex items-stretch gap-[var(--chat-space-block)]"
            >
              <div className="flex w-[19px] shrink-0 flex-col items-center" aria-hidden>
                <span className="w-px flex-1 bg-border" data-activity-rail />
              </div>
              <div className="min-w-0 flex-1">
                <div className="rounded-md bg-ink-fill px-2.5 py-1.5">
                  <Markdown variant="compact">{view.summary}</Markdown>
                </div>
              </div>
            </div>
          ) : null}

          {view.documents.length > 0 ? (
            <div data-compaction-documents className="flex flex-col">
              {view.documents.map((document) => (
                <CompactionDocument key={document.uri} document={document} />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function CompactionDocument({ document }: { document: DividerDocument }) {
  return (
    <ActivityRow
      Icon={BookOpen}
      quietIcon
      title={<CommandTitle verb={t`Read`} parameter={<DocumentName path={document.uri} />} />}
      expand={
        document.body
          ? () => (
              <ClippedProse
                className="text-tier-quoted"
                footer={
                  <span className="flex min-w-0 text-xs">
                    <DocumentName path={document.uri} label="open" />
                  </span>
                }
              >
                <Markdown variant="compact">{document.body}</Markdown>
              </ClippedProse>
            )
          : undefined
      }
    />
  );
}

function CompactionInfo({ view }: { view: DividerView }) {
  const statsForNerds = useStatsForNerds();
  const { model, tokens } = view;
  if (!statsForNerds || (!model && !tokens)) return null;
  return (
    <TurnInfoButton
      label={t`Compaction information`}
      sections={[
        {
          title: t`Compaction`,
          rows: (
            <>
              {model ? (
                <TurnInfoRow
                  label={t`Model`}
                  value={model}
                  valueClassName="max-w-36 truncate font-medium"
                  title={model}
                />
              ) : null}
              {tokens ? (
                <>
                  <TurnInfoRow label={t`Tokens before`} value={formatTokens(tokens.before)} mono />
                  <TurnInfoRow label={t`Tokens after`} value={formatTokens(tokens.after)} mono />
                </>
              ) : null}
            </>
          ),
        },
      ]}
    />
  );
}

function DividerLabel({ label, className }: { label: StateLabel; className: string }) {
  return (
    <span data-compaction-label className={cn("min-w-0 truncate text-xs font-medium", className)}>
      <span className="hidden @lg/divider:inline">{label.full}</span>
      <span className="@lg/divider:hidden">{label.short}</span>
    </span>
  );
}

export function DividerRule() {
  return <span aria-hidden className="h-px min-w-3 flex-1 bg-border" />;
}

function DividerMark({ state }: { state: DividerView["state"] }) {
  if (state === "pending") return <span aria-hidden className="streaming-dot mx-1" />;
  return <FoldVertical aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />;
}

function formatTokens(value: number): string {
  return new Intl.NumberFormat(i18n.locale || undefined).format(value);
}
