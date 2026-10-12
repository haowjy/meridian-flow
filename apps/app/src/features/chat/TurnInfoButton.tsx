/**
 * The info button on a finished turn's action row, and its popover of stats.
 *
 * One pattern for every turn that has numbers worth reading: a reply's usage
 * and a compaction divider's context sizes open the same quiet popover of
 * labeled rows, grouped in titled sections. Callers decide the rows; this owns
 * the trigger, the popover, and the grid.
 */
import { Info } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { IconButton } from "@/components/ui/icon-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { TURN_ACTION_TOOLTIP_SIDE } from "./turn-action-tooltip";

export type TurnInfoSection = { title: string; rows: ReactNode };

export function TurnInfoRow({
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

export function TurnInfoButton({
  label,
  sections,
}: {
  /** The button's name and tooltip. */
  label: string;
  sections: readonly TurnInfoSection[];
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <IconButton type="button" tooltip={label} tooltipSide={TURN_ACTION_TOOLTIP_SIDE}>
          <Info aria-hidden />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent align="start" className="text-tier-chat chat-card w-64">
        <dl className="grid grid-cols-[1fr_auto] gap-x-[var(--chat-space-block)] gap-y-[var(--chat-space-row)] text-xs">
          {sections.map(({ title, rows }, index) => (
            <Fragment key={title}>
              <dt
                className={`col-span-2 font-medium text-foreground ${
                  index > 0
                    ? "mt-[var(--chat-space-row)] border-t border-border pt-[var(--chat-space-row)]"
                    : ""
                }`}
              >
                {title}
              </dt>
              {rows}
            </Fragment>
          ))}
        </dl>
      </PopoverContent>
    </Popover>
  );
}
