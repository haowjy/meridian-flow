/**
 * The dialog body for a chosen selection: where files land, what is left out and
 * what is over a limit. Used by the import dialog; pure of state.
 */
import { i18n } from "@lingui/core";
import { plural, t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { FileText, Folder, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { filenameForDisplay } from "./display-name";
import { formatBytes } from "./format-size";
import { IMPORT_FILE_LIMITS } from "./limits";
import type { RootSummary, SelectionSummary } from "./summarize-selection";

const MAX_LISTED_ROOTS = 8;

export function rootLine(root: RootSummary): string {
  if (root.kind === "file") return "";
  const files = root.files;
  const folders = root.folders;
  if (folders === 0) return plural(files, { one: "# file", other: "# files" });
  const count = i18n.number(folders);
  if (folders === 1)
    return plural(files, { one: "# file in 1 folder", other: "# files in 1 folder" });
  return plural(files, {
    one: `# file in ${count} folders`,
    other: `# files in ${count} folders`,
  });
}

export function SelectionCards({ summary }: { summary: SelectionSummary }) {
  const shown = summary.roots.length > MAX_LISTED_ROOTS ? summary.roots.slice(0, 7) : summary.roots;
  const more = summary.roots.length - shown.length;
  return (
    <ul className="grid gap-2 rounded-lg border border-border-subtle bg-card p-3">
      {shown.map((root) => (
        <li key={root.rootId} className="flex items-start gap-2.5">
          {root.kind === "folder" ? (
            <Folder aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-muted" />
          ) : (
            <FileText aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-muted" />
          )}
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-medium text-foreground">{root.name}</span>
            {root.kind === "folder" ? (
              <span className="text-caption text-ink-muted">{rootLine(root)}</span>
            ) : null}
          </span>
        </li>
      ))}
      {more > 0 ? (
        <li className="pl-6.5 text-caption text-ink-muted">
          {plural(more, { one: "and # more", other: "and # more" })}
        </li>
      ) : null}
    </ul>
  );
}

/** The sentences that say where the files go. They are the dialog's description. */
export function LandsSentences({
  summary,
  destination,
}: {
  summary: SelectionSummary;
  destination: string;
}): ReactNode {
  if (summary.meridianExport) {
    return (
      <>
        <span className="block">
          <Trans>
            This is a Meridian export. Manuscript, Knowledge Base and Unfiled go back to their own
            areas, wherever you start the import.
          </Trans>
        </span>
        {summary.meridianExport.hasWorks ? (
          <span className="block">
            <Trans>
              Works isn't imported. To bring back a Work's Scratch, import that folder on its own.
            </Trans>
          </span>
        ) : null}
      </>
    );
  }
  const folders = summary.roots.filter((root) => root.kind === "folder");
  const files = summary.roots.filter((root) => root.kind === "file");
  const example = summary.roots[0] ? filenameForDisplay(summary.roots[0].name) : "";
  return (
    <>
      {folders.length === 1 ? (
        <span className="block">
          {t`${folders[0].name} becomes a new folder in ${destination}.`}
        </span>
      ) : folders.length > 1 ? (
        <span className="block">{t`Each folder becomes a new folder in ${destination}.`}</span>
      ) : null}
      {files.length > 0 && folders.length === 0 ? (
        <span className="block">
          {plural(files.length, {
            one: `This file goes into ${destination}, beside what's already there.`,
            other: `These # files go into ${destination}, beside what's already there.`,
          })}
        </span>
      ) : null}
      {files.length > 0 && folders.length > 0 ? (
        <span className="block">
          {plural(files.length, {
            one: `The other file goes into ${destination} beside them.`,
            other: `The # other files go into ${destination} beside them.`,
          })}
        </span>
      ) : null}
      <span className="block">{t`Names already in use get a number, like ${example} (2). Nothing is replaced.`}</span>
    </>
  );
}

function Warning({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 text-sm text-foreground">
      <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-status-warning" />
      <span>{children}</span>
    </p>
  );
}

export function SelectionWarnings({ summary }: { summary: SelectionSummary }) {
  return (
    <div className="grid gap-1.5">
      {summary.roots.flatMap((root) => [
        root.unreadableFiles > 0 ? (
          <Warning key={`${root.rootId}:files`}>
            {plural(root.unreadableFiles, {
              one: `Couldn't read # file in ${root.name}. It'll be left out.`,
              other: `Couldn't read # files in ${root.name}. They'll be left out.`,
            })}
          </Warning>
        ) : null,
        ...root.unreadablePaths.map((path) => (
          <Warning key={`${root.rootId}:${path}`}>
            {t`Couldn't open the folder ${path}. It'll be left out.`}
          </Warning>
        )),
      ])}
      {summary.leftOut.map((item) => (
        <Warning key={`${item.kind}:${item.name}`}>
          {item.kind === "folder"
            ? t`Couldn't open the folder ${item.name}. It'll be left out.`
            : t`Couldn't read ${item.name}. It'll be left out.`}
        </Warning>
      ))}
      {summary.oversize > 0 ? (
        <Warning>
          {plural(summary.oversize, {
            one: "# file is over 50 MB and won't be imported.",
            other: "# files are over 50 MB and won't be imported.",
          })}
        </Warning>
      ) : null}
      {summary.roots
        .filter((root) => root.zip)
        .map((root) => (
          <Warning key={`zip:${root.rootId}`}>
            {t`${root.name} is a ZIP. It's imported as a file. To import what's inside, unzip it first and import the folder.`}
          </Warning>
        ))}
    </div>
  );
}

/** The limit that stops Import, as a sentence; null when the selection can go. */
export function limitSentence(summary: SelectionSummary, origin: "pick" | "drop"): string | null {
  if (summary.limit === "empty")
    return origin === "pick"
      ? t`That folder has no files to import.`
      : t`There are no files to import here.`;
  if (summary.limit === "too-many") {
    const count = i18n.number(summary.files);
    const limit = i18n.number(IMPORT_FILE_LIMITS.files);
    return t`That's ${count} files. Import up to ${limit} at a time.`;
  }
  if (summary.limit === "too-big") {
    const size = formatBytes(summary.bytes);
    return t`That's ${size}. Import up to 2 GB at a time.`;
  }
  return null;
}
