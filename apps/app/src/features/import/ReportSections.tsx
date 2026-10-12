/** The report's sections: rows with an Open button and sibling actions, never a button in a button. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ChevronRight, FileText, Folder } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { fileKindIcon } from "@/features/project/context/context-file-icon";
import { cn } from "@/lib/utils";
import { type FindingGroup, groupNote, groupTitle, skipLine, skipNote } from "./finding-copy";
import { failureSentence } from "./reason-copy";
import type { EntryRow, FindingRow, ReportModel } from "./report-model";

const LISTED = 20;

export function Section({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count?: number;
  action?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="mt-9">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id={id} className="text-sm font-semibold text-foreground">
          {title}
          {count !== undefined ? (
            <span className="ml-1.5 font-normal text-ink-muted">({count})</span>
          ) : null}
        </h2>
        {action}
      </div>
      <div className="mt-2">{children}</div>
    </section>
  );
}

const rowClass =
  "focus-ring flex min-w-0 flex-1 items-start gap-3 rounded-md px-1 py-2 text-left disabled:cursor-default";

/** One item: an icon, a name, a sentence. Opens its document when it can. */
export function ItemRow({
  name,
  sentence,
  folder,
  openable,
  onOpen,
  icon,
  actions,
  openLabel,
}: {
  name: string;
  sentence?: string;
  folder?: string;
  openable: boolean;
  onOpen?: () => void;
  icon?: ReactNode;
  actions?: ReactNode;
  openLabel?: string;
}) {
  const body = (
    <>
      <span className="mt-0.5 shrink-0 text-ink-muted">
        {icon ?? <FileText aria-hidden className="size-4" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="truncate text-sm font-medium text-foreground">{name}</span>
          {folder ? <span className="truncate text-xs text-ink-muted">{folder}</span> : null}
        </span>
        {sentence ? (
          <span className="block whitespace-pre-line text-sm text-ink-muted">{sentence}</span>
        ) : null}
      </span>
      {openable ? (
        <ChevronRight aria-hidden className="mt-1 size-3.5 shrink-0 text-ink-subtle" />
      ) : null}
    </>
  );
  return (
    <li className="flex items-start gap-2">
      {openable && onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          aria-label={openLabel ?? (sentence ? `${name}. ${sentence}` : name)}
          className={cn(rowClass, "hover:bg-sidebar-accent/50")}
        >
          {body}
        </button>
      ) : (
        <div className={rowClass}>{body}</div>
      )}
      {actions ? <div className="flex shrink-0 items-center gap-1.5 py-1.5">{actions}</div> : null}
    </li>
  );
}

function entryIcon(row: EntryRow) {
  const Icon = fileKindIcon(row.name);
  return <Icon aria-hidden className="size-4" />;
}

export function FailedSection({
  rows,
  canRetry,
  onRetry,
  onRetryAll,
  onOpen,
}: {
  rows: EntryRow[];
  /** This tab still holds the files. */
  canRetry: boolean;
  onRetry: (entryId: number) => void;
  onRetryAll: () => void;
  onOpen: (row: EntryRow) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <Section
      title={t`Didn't import`}
      count={rows.length}
      action={
        canRetry ? (
          <Button size="sm" variant="outline" onClick={onRetryAll}>
            <Trans>Retry all</Trans>
          </Button>
        ) : null
      }
    >
      <ul>
        {rows.map((row) => {
          const sentence = failureSentence(row.entry.reason);
          const wroteHere = row.entry.reason === "edited_before_arrival";
          return (
            <ItemRow
              key={row.key}
              name={row.name}
              sentence={sentence}
              openable={row.openable}
              onOpen={() => onOpen(row)}
              icon={entryIcon(row)}
              actions={
                canRetry ? (
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={
                      wroteHere
                        ? t`Add imported text at the top of ${row.name}`
                        : t`Retry ${row.name}`
                    }
                    onClick={() => onRetry(row.entry.entryId)}
                  >
                    {wroteHere ? <Trans>Add imported text at the top</Trans> : <Trans>Retry</Trans>}
                  </Button>
                ) : null
              }
            />
          );
        })}
      </ul>
    </Section>
  );
}

function Group({
  group,
  rows,
  onOpen,
}: {
  group: FindingGroup;
  rows: FindingRow[];
  onOpen: (row: EntryRow) => void;
}) {
  const [open, setOpen] = useState(true);
  const [all, setAll] = useState(false);
  const id = useId();
  const note = groupNote(group);
  const shown = all ? rows : rows.slice(0, LISTED);
  return (
    <div className="mt-3">
      <h3 className="text-sm font-medium text-foreground">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen(!open)}
          className="focus-ring flex items-center gap-1.5 rounded-md py-1 text-left"
        >
          <ChevronRight
            aria-hidden
            className={cn("size-3.5 text-ink-muted transition-transform", open && "rotate-90")}
          />
          <span>{groupTitle(group)}</span>
          <span className="font-normal text-ink-muted">({rows.length})</span>
        </button>
      </h3>
      {open ? (
        <div id={id} className="pl-5">
          {note ? <p className="text-sm text-ink-muted">{note}</p> : null}
          <ul>
            {shown.map((row) => (
              <ItemRow
                key={row.key}
                name={row.name}
                folder={row.folder}
                sentence={row.sentence}
                openable={row.openable}
                onOpen={() => onOpen(row)}
                icon={entryIcon(row)}
              />
            ))}
          </ul>
          {rows.length > LISTED && !all ? (
            <Button variant="ghost" size="sm" onClick={() => setAll(true)}>
              {t`Show all ${rows.length}`}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function WorthALookSection({
  model,
  onOpen,
}: {
  model: ReportModel;
  onOpen: (row: EntryRow) => void;
}) {
  if (model.worthALook.length === 0) return null;
  return (
    <Section title={t`Worth a look`} count={model.worthALookCount}>
      {model.worthALook.map(({ group, rows }) => (
        <Group key={group} group={group} rows={rows} onOpen={onOpen} />
      ))}
    </Section>
  );
}

export function RenamedSection({
  rows,
  onOpen,
}: {
  rows: ReportModel["renamed"];
  onOpen: (row: EntryRow) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <Section title={t`Renamed`} count={rows.length}>
      <ul>
        {rows.map((row) =>
          "root" in row ? (
            <ItemRow
              key={row.key}
              name={row.name}
              sentence={t`${row.sentence} was taken.`}
              openable={false}
              icon={<Folder aria-hidden className="size-4" />}
            />
          ) : (
            <ItemRow
              key={row.key}
              name={row.name}
              sentence={row.sentence}
              openable={row.openable}
              onOpen={() => onOpen(row)}
              icon={entryIcon(row)}
            />
          ),
        )}
      </ul>
    </Section>
  );
}

export function SkippedSection({ model }: { model: ReportModel }) {
  if (model.skipped.length === 0) return null;
  return (
    <Section title={t`Skipped`} count={model.skippedCount}>
      <ul>
        {model.skipped.map((line) => (
          <li key={line.key} className="flex items-baseline gap-3 px-1 py-1.5 text-sm">
            <span className="text-foreground">
              {skipLine(line.line, { name: line.name, count: line.count })}
            </span>
            {skipNote(line.reason) && !line.line ? (
              <span className="text-ink-muted">{skipNote(line.reason)}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </Section>
  );
}

function SubGroup({
  title,
  note,
  rows,
  onOpen,
  openable,
  sentence,
}: {
  title: string;
  note?: string;
  rows: EntryRow[];
  onOpen: (row: EntryRow) => void;
  openable: boolean;
  sentence?: (row: EntryRow) => string | undefined;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="mt-3">
      <h3 className="text-sm font-medium text-foreground">
        {title} <span className="font-normal text-ink-muted">({rows.length})</span>
      </h3>
      {note ? <p className="text-sm text-ink-muted">{note}</p> : null}
      <ul>
        {rows.map((row) => (
          <ItemRow
            key={row.key}
            name={row.name}
            folder={row.folder}
            sentence={sentence?.(row)}
            openable={openable && row.openable}
            onOpen={() => onOpen(row)}
            icon={entryIcon(row)}
          />
        ))}
      </ul>
    </div>
  );
}

export function NotImportedSection({
  model,
  onOpen,
}: {
  model: ReportModel;
  onOpen: (row: EntryRow) => void;
}) {
  const { emptyKept, keptWithWrote, neverCreated, deleted } = model.notImported;
  const count = emptyKept.length + keptWithWrote.length + neverCreated.length + deleted.length;
  if (count === 0) return null;
  return (
    <Section title={t`Not imported`} count={count}>
      <SubGroup
        title={t`Kept as empty documents`}
        note={t`Delete them like any other document if you don't need them.`}
        rows={emptyKept}
        onOpen={onOpen}
        openable
      />
      <SubGroup title={t`Kept with what you wrote`} rows={keptWithWrote} onOpen={onOpen} openable />
      <SubGroup title={t`Never created`} rows={neverCreated} onOpen={onOpen} openable={false} />
      <SubGroup
        title={t`Deleted before they arrived`}
        rows={deleted}
        onOpen={onOpen}
        openable={false}
        sentence={(row) => failureSentence(row.entry.reason)}
      />
    </Section>
  );
}

export function RootsBlock({
  roots,
  areasMessage,
  onOpenRoot,
  summary,
}: {
  roots: { rootId: number; kind: "folder" | "file"; name: string; openable: boolean }[];
  areasMessage?: ReactNode;
  onOpenRoot: (rootId: number) => void;
  summary: string[];
}) {
  return (
    <div className="mt-8">
      {areasMessage ? <p className="text-sm text-foreground">{areasMessage}</p> : null}
      <ul>
        {roots.map((root) => (
          <ItemRow
            key={root.rootId}
            name={root.name}
            openable={false}
            icon={
              root.kind === "folder" ? (
                <Folder aria-hidden className="size-4" />
              ) : (
                <FileText aria-hidden className="size-4" />
              )
            }
            actions={
              root.openable ? (
                <Button
                  size="sm"
                  variant="outline"
                  aria-label={t`Open ${root.name}`}
                  onClick={() => onOpenRoot(root.rootId)}
                >
                  <Trans>Open</Trans>
                </Button>
              ) : null
            }
          />
        ))}
      </ul>
      {summary.length > 0 ? (
        <p className="mt-1 px-1 text-sm text-ink-muted">{summary.join(" ")}</p>
      ) : null}
    </div>
  );
}
