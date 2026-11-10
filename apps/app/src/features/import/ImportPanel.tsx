/** What an import shows the writer, in the popup on desktop and the sheet on a phone. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { entryNeedsLook, type ImportEntryStatus } from "@meridian/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Files, Folder, type LucideIcon, X } from "lucide-react";
import { type ReactNode, useRef } from "react";
import { useContextCatalogView } from "@/client/query/useContextCatalog";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Button } from "@/components/ui/button";
import {
  dropdownGroupLabelClass,
  dropdownPageClass,
  dropdownRowVariants,
} from "@/components/ui/dropdown-presentation";
import { PhoneIconButton } from "@/components/ui/phone-icon-button";
import { Progress } from "@/components/ui/progress";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { projectAddressHref } from "@/features/project/routing/project-address";
import { cn } from "@/lib/utils";
import { type PickKind, useOptionalImports } from "./ImportProvider";
import type { TrackedImport } from "./import-coordinator";
import { type ImportStatus, importPresentation, importScheme } from "./import-presentation";
import { readPicked } from "./read-picked";
import { problemSentences } from "./reason-copy";
import { canPickFolders, PickInputs } from "./SelectionPicker";

/** The accessible name of an Import button that stands for imports. */
export function importLabel(status: ImportStatus | null): string {
  if (status === "running") return t`Import, in progress`;
  if (status === "needs-writer") return t`Import, needs your attention`;
  return t`Import…`;
}

function ImportCard({
  item,
  touch,
  onClose,
}: {
  item: TrackedImport;
  touch: boolean;
  onClose: () => void;
}) {
  const coordinator = useOptionalImports()?.coordinator;
  const { importId, summary, local, detail } = item;
  const folder = useRef<HTMLInputElement>(null);
  const files = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const scheme = importScheme(summary);
  const { catalog } = useContextCatalogView(summary.projectId, scheme, {});
  if (!coordinator) return null;
  const presentation = importPresentation(summary, local);
  const { state, title, progress } = presentation;
  const pick = () => (summary.label.kind === "files" ? files : folder).current?.click();
  const button = (label: string, run: () => void, primary = false) => (
    <Button
      key={label}
      size="sm"
      variant={primary ? "default" : "ghost"}
      disabled={local.busy}
      onClick={run}
    >
      {label}
    </Button>
  );
  const retry = () => void coordinator.retry(importId);
  const show = () => {
    const root = summary.root ? catalog?.normalized.entries.get(summary.root.id) : null;
    const parent = summary.destination.folderId
      ? catalog?.normalized.entries.get(summary.destination.folderId)
      : null;
    const path =
      root?.kind === "folder"
        ? root.path.join("/")
        : parent?.kind === "folder"
          ? parent.path.join("/")
          : "";
    // An import shows one of its files, one that needs a look first; a browse address opens none.
    const file = [...problems, ...(detail?.entries ?? [])]
      .map((entry) => catalog?.findDocument(entry.documentId))
      .find(Boolean);
    void navigate({
      to: projectAddressHref({
        projectId: summary.projectId,
        destination: file
          ? { kind: "document", scheme, path: file.path.replace(/^\/+/, "") }
          : { kind: "browse", scheme, path },
        work: { kind: "absent" },
      }),
    });
    onClose();
  };
  const actions =
    state === "stop" ? (
      <>
        {button(t`Keep going`, () => coordinator.askStop(importId, false))}
        {button(t`Stop and discard`, () => void coordinator.stop(importId), true)}
      </>
    ) : state === "done" || state === "needs-look" ? (
      button(t`Show`, show, true)
    ) : state === "expired" ? null : (
      <>
        {local.stopLost ? null : button(t`Stop`, () => coordinator.askStop(importId, true))}
        {state === "paused" || state === "wrong-root" ? (
          button(t`Continue…`, pick, true)
        ) : state === "missing" ? (
          <>
            {button(t`Pick again`, pick)}
            {button(t`Import without them`, () => void coordinator.withoutMissing(importId), true)}
          </>
        ) : state === "stalled" ? (
          button(t`Retry`, retry, true)
        ) : state === "failed" ? (
          button(t`Try again`, retry, true)
        ) : null}
      </>
    );
  const rootName = (rootId: ImportEntryStatus["rootId"]) =>
    detail?.roots.find((root) => root.rootId === rootId)?.name;
  const problems = detail?.entries.filter(entryNeedsLook) ?? [];
  const skipped =
    detail?.entries
      .filter((entry) => entry.state === "skipped" && !problems.includes(entry))
      .map((entry) => entry.path || rootName(entry.rootId)) ?? [];
  return (
    <li className="px-3 py-2.5">
      <div className="break-words text-sm font-medium text-foreground">{title}</div>
      {presentation.detail ? (
        <div className="mt-0.5 text-caption text-muted-foreground">{presentation.detail}</div>
      ) : null}
      {progress === undefined ? null : progress === "indeterminate" ? (
        <Progress indeterminate label={title} className="mt-2 h-1" />
      ) : (
        <Progress value={progress} label={title} className="mt-2 h-1" />
      )}
      <div className="mt-2 space-y-2 text-caption text-muted-foreground empty:hidden">
        {presentation.note ? <p>{presentation.note}</p> : null}
        {presentation.fallback ? <p>{presentation.fallback}</p> : null}
        {local.stopLost ? (
          <p>
            <Trans>It finished before it could stop.</Trans>
          </p>
        ) : null}
        {local.error ? (
          <InlineErrorRow
            message={local.error}
            wrap
            className="p-0"
            onRetry={
              local.stopLost || (summary.state === "finished" && detail?.state !== "finished")
                ? () => void coordinator.loadDetail(importId)
                : undefined
            }
          />
        ) : null}
        {state === "needs-look" ? (
          <details>
            <summary className="cursor-pointer text-foreground">
              <Trans>See files</Trans>
            </summary>
            <ul className="mt-2 max-h-48 space-y-2 overflow-y-auto">
              {problems.map((entry) => (
                <li key={entry.entryId}>
                  <span className="block break-words text-foreground">
                    {entry.path || rootName(entry.rootId)}
                  </span>
                  {problemSentences(entry).join(" ")}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        {skipped.length ? (
          <p className="break-words">
            <Trans>Not imported: {skipped.join(", ")}</Trans>
          </p>
        ) : null}
      </div>
      {actions ? (
        <div
          className={cn(
            "mt-2 flex flex-wrap justify-end gap-2",
            touch && "[&_[data-slot=button]]:min-h-11",
          )}
        >
          {actions}
        </div>
      ) : null}
      <PickInputs
        folderRef={folder}
        filesRef={files}
        onPick={(picked) => {
          void readPicked(picked).then((selection) => coordinator.continue(importId, selection));
        }}
      />
    </li>
  );
}

/** The imports an entry point stands for, then the way to start another. */
export function ImportPanelBody({
  items,
  touch = false,
  onPick,
  onClose,
}: {
  items: readonly TrackedImport[];
  touch?: boolean;
  onPick: (kind: PickKind) => void;
  onClose: () => void;
}) {
  const pickRow = (kind: PickKind, Icon: LucideIcon, label: ReactNode) => (
    <button type="button" className={dropdownRowVariants()} onClick={() => onPick(kind)}>
      <Icon className="text-muted-foreground" aria-hidden />
      {label}
    </button>
  );
  return (
    <>
      {items.length > 0 ? (
        <ul className="min-h-0 divide-y divide-border-subtle overflow-y-auto overscroll-contain">
          {items.map((item) => (
            <ImportCard key={item.importId} item={item} touch={touch} onClose={onClose} />
          ))}
        </ul>
      ) : null}
      <div
        className={cn(
          "flex shrink-0 flex-col",
          dropdownPageClass,
          items.length > 0 && "border-t border-border-subtle",
        )}
      >
        {items.length > 0 ? (
          <p className={dropdownGroupLabelClass}>
            <Trans>Import another</Trans>
          </p>
        ) : null}
        {canPickFolders() ? pickRow("folder", Folder, <Trans>Folder…</Trans>) : null}
        {pickRow("files", Files, <Trans>Files…</Trans>)}
      </div>
    </>
  );
}

/** The phone's popup: the same content in a bottom sheet. */
export function ImportSheet({
  items,
  open,
  onOpenChange,
  onPick,
}: {
  items: readonly TrackedImport[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (kind: PickKind) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        showCloseButton={false}
        className="max-h-[78svh] gap-0 rounded-t-xl border-border-subtle p-0"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div aria-hidden className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-border" />
        <div className="flex shrink-0 items-center gap-2 pl-4 pr-1">
          <SheetTitle className="min-w-0 flex-1 truncate text-sm">
            <Trans>Imports</Trans>
          </SheetTitle>
          <PhoneIconButton aria-label={t`Close`} onClick={() => onOpenChange(false)}>
            <X className="size-5" aria-hidden />
          </PhoneIconButton>
        </div>
        <SheetDescription className="sr-only">
          <Trans>Your imports in this project, with their controls.</Trans>
        </SheetDescription>
        <ImportPanelBody items={items} touch onPick={onPick} onClose={() => onOpenChange(false)} />
      </SheetContent>
    </Sheet>
  );
}
