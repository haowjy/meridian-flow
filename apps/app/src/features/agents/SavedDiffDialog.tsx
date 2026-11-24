import { plural, t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { AgentFileChange } from "@meridian/contracts/agents";
import { Fragment, useMemo, useState } from "react";
import { useSavedAgentFile } from "@/client/query/useAgentFiles";
import { useProjectContextRead } from "@/client/query/useProjectContextRead";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { ViewerDialog } from "@/components/app/ViewerDialog";
import { Chip } from "@/components/ui/chip";
import { role } from "@/components/ui/roles";
import { cn } from "@/lib/utils";
import type { PackageRef } from "./package-save";
import { type DiffCell, type DiffRow, diffRows, foldRows } from "./saved-diff";

export function SavedDiffDialog({
  projectId,
  pkg,
  saveId,
  change,
  documentId,
  onClose,
}: {
  projectId: string;
  pkg: PackageRef;
  saveId: string | null;
  change: AgentFileChange | null;
  documentId: string | null;
  onClose: () => void;
}) {
  const [shown, setShown] = useState(change);
  if (change && change !== shown) setShown(change);
  const saved = useSavedAgentFile(
    shown && shown.change !== "added"
      ? { projectId, level: pkg.level, path: shown.path, saveId }
      : null,
  );
  const now = useProjectContextRead(projectId, shown?.change === "deleted" ? null : documentId);
  const nowText = now.data?.kind === "tracked" ? now.data.content : undefined;
  const savedSide = shown?.change === "added" ? null : saved.data;
  const nowSide = shown?.change === "deleted" ? null : nowText;
  const failed =
    (shown?.change !== "added" && saved.isError) ||
    (shown?.change !== "deleted" && (now.isError || documentId === null));
  return (
    <ViewerDialog
      open={change !== null}
      onClose={onClose}
      title={shown?.path ?? ""}
      titleExtra={shown ? <ChangeChip change={shown.change} /> : null}
      description={t`What changed in this file since it was last saved, read-only`}
    >
      {failed ? (
        <InlineErrorRow message={t`Couldn't load this file.`} className="px-4 py-3" />
      ) : savedSide === undefined || nowSide === undefined ? (
        <p role="status" className={cn(role.emptyLine, "px-4 py-3")}>
          <Trans>Loading…</Trans>
        </p>
      ) : (
        <DiffView saved={savedSide} now={nowSide} />
      )}
    </ViewerDialog>
  );
}

function ChangeChip({ change }: { change: AgentFileChange["change"] }) {
  switch (change) {
    case "added":
      return (
        <Chip tone="jade">
          <Trans>Added</Trans>
        </Chip>
      );
    case "changed":
      return (
        <Chip>
          <Trans>Changed</Trans>
        </Chip>
      );
    case "deleted":
      return (
        <Chip tone="destructive">
          <Trans>Deleted</Trans>
        </Chip>
      );
  }
}

function DiffView({ saved, now }: { saved: string | null; now: string | null }) {
  const blocks = useMemo(() => foldRows(diffRows(saved, now)), [saved, now]);
  const [opened, setOpened] = useState<ReadonlySet<number>>(new Set());
  const both = saved !== null && now !== null;
  if (both && saved === now)
    return (
      <p role="status" className={cn(role.emptyLine, "px-4 py-3")}>
        <Trans>No differences from the saved version</Trans>
      </p>
    );
  const sides = { saved: saved !== null, now: now !== null };
  if (blocks.length === 0)
    return (
      <p className={cn(role.emptyLine, "px-4 py-3")}>
        <Trans>Empty file</Trans>
      </p>
    );
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div
        className={cn(
          "grid min-w-0 font-mono text-xs leading-5",
          both
            ? "grid-cols-[auto_minmax(0,1fr)] sm:grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,1fr)]"
            : "grid-cols-[auto_minmax(0,1fr)]",
        )}
      >
        <div
          className={cn(
            "sticky top-0 z-10 col-span-full grid grid-cols-subgrid border-border-subtle border-b bg-background font-sans text-muted-foreground",
            both && "max-sm:hidden",
          )}
        >
          {sides.saved ? (
            <span className="col-span-2 px-3 py-1.5">
              <Trans>Saved</Trans>
            </span>
          ) : null}
          {sides.now ? (
            <span className={cn("col-span-2 px-3 py-1.5", both && "border-border-subtle border-l")}>
              <Trans>Now</Trans>
            </span>
          ) : null}
        </div>
        {blocks.map((block) =>
          block.kind === "fold" && !opened.has(block.start) ? (
            <button
              key={`fold-${block.start}`}
              type="button"
              className="focus-ring col-span-full border-border-subtle border-y bg-ink-fill px-3 py-1 text-left font-sans text-muted-foreground hover:bg-ink-fill-strong"
              onClick={() => setOpened(new Set(opened).add(block.start))}
            >
              {plural(block.rows.length, {
                one: "Show # unchanged line",
                other: "Show # unchanged lines",
              })}
            </button>
          ) : (
            <Fragment key={block.kind === "fold" ? `fold-${block.start}` : rowKey(block.rows[0])}>
              {block.rows.map((row) => (
                <Row key={rowKey(row)} row={row} sides={sides} />
              ))}
            </Fragment>
          ),
        )}
      </div>
    </div>
  );
}

const rowKey = (row: DiffRow) => `${row.saved?.n ?? "-"}:${row.now?.n ?? "-"}`;

function Row({ row, sides }: { row: DiffRow; sides: { saved: boolean; now: boolean } }) {
  const both = sides.saved && sides.now;
  const same = row.kind === "same";
  return (
    <>
      {sides.saved ? (
        <Cell
          cell={row.saved}
          labelNarrow={both}
          tone={same ? null : "removed"}
          hideNarrow={both && (same || row.saved === null)}
        />
      ) : null}
      {sides.now ? (
        <Cell
          cell={row.now}
          labelNarrow={both}
          tone={same ? null : "added"}
          divider={both}
          hideNarrow={both && row.now === null}
        />
      ) : null}
    </>
  );
}

function Cell({
  cell,
  tone,
  divider,
  hideNarrow,
  labelNarrow,
}: {
  cell: DiffCell | null;
  tone: "added" | "removed" | null;
  divider?: boolean;
  hideNarrow: boolean;
  labelNarrow: boolean;
}) {
  const tint =
    cell === null
      ? "bg-ink-fill"
      : tone === "added"
        ? "bg-primary/12"
        : tone === "removed"
          ? "bg-destructive/12"
          : "";
  const mark = tone === "added" ? "bg-primary/25" : "bg-destructive/25";
  return (
    <>
      <span
        aria-hidden
        className={cn(
          "select-none px-2 text-right text-muted-foreground tabular-nums",
          divider && "sm:border-border-subtle sm:border-l",
          tint,
          hideNarrow && "max-sm:hidden",
        )}
      >
        {cell?.n ?? ""}
      </span>
      <span
        className={cn(
          "whitespace-pre-wrap break-words pr-3 text-foreground",
          tint,
          hideNarrow && "max-sm:hidden",
        )}
      >
        {labelNarrow && cell && tone !== null ? (
          <span className="block font-sans text-muted-foreground sm:hidden">
            {tone === "added" ? <Trans>Now</Trans> : <Trans>Saved</Trans>}
          </span>
        ) : null}
        {cell?.empty ? (
          <Trans>Empty file</Trans>
        ) : cell === null ? null : tone === null ? (
          cell.text || " "
        ) : (
          <>
            <span className="sr-only">{tone === "added" ? t`Added: ` : t`Removed: `}</span>
            {cell.runs
              ? cell.runs.map((run, index) => (
                  <span key={index} className={run.changed ? cn("rounded-sm", mark) : undefined}>
                    {run.text}
                  </span>
                ))
              : cell.text || " "}
          </>
        )}
        {cell && !cell.empty && tone !== null && cell.ending === "none" ? (
          <span className="block text-muted-foreground">
            <Trans>No newline at end of file</Trans>
          </span>
        ) : cell && tone !== null && cell.ending === "CRLF" ? (
          <span className="block text-muted-foreground">
            <Trans>CRLF line ending</Trans>
          </span>
        ) : cell && tone !== null && cell.ending === "LF" ? (
          <span className="block text-muted-foreground">
            <Trans>LF line ending</Trans>
          </span>
        ) : null}
      </span>
    </>
  );
}
