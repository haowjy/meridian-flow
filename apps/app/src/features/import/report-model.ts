/**
 * What the report page shows, as data: the sections, their items and the
 * sentences, from one import's merged state. Pure; the page only lays it out.
 */
import type { ImportEntryReport } from "@meridian/contracts";
import { filenameForDisplay } from "./display-name";
import {
  type FindingGroup,
  findingGroup,
  findingSentence,
  keptAsTextSentence,
} from "./finding-copy";
import { effectiveEntry, type ImportState } from "./import-state";
import { catalogPathOfUri } from "./tree-projection";

export type EntryRow = {
  key: string;
  entry: ImportEntryReport;
  /** The name the writer knows it by: the final name, with a picture's or PDF's extension. */
  name: string;
  /** Where it lives now ("Chapters" for Chapters/Ch 2), for the muted path. */
  folder: string;
  openable: boolean;
};

export type FindingRow = EntryRow & { sentence: string };

export const WORTH_A_LOOK_ORDER: readonly FindingGroup[] = [
  "hidden",
  "links",
  "pictures",
  "kept",
  "settings",
  "other",
];

export type SkippedLine = {
  key: string;
  line: string | null;
  name: string;
  reason: string | null;
  count: number;
};

export type ReportModel = {
  roots: {
    rootId: number;
    kind: "folder" | "file";
    name: string;
    uri: string | null;
    id: string | null;
  }[];
  /** Areas that received files, for a Meridian export (roots have no wrapper folder). */
  areas: string[];
  failed: EntryRow[];
  worthALook: { group: FindingGroup; rows: FindingRow[] }[];
  worthALookCount: number;
  renamed: (FindingRow | { key: string; name: string; sentence: string; root: true })[];
  skipped: SkippedLine[];
  skippedCount: number;
  notImported: {
    emptyKept: EntryRow[];
    keptWithWrote: EntryRow[];
    neverCreated: EntryRow[];
    deleted: EntryRow[];
  };
};

function rowOf(entry: ImportEntryReport, key: string): EntryRow {
  const path = catalogPathOfUri(entry.uri);
  const slash = path ? path.lastIndexOf("/") : -1;
  return {
    key,
    entry,
    name: path ? filenameForDisplay(path.slice(slash + 1)) : filenameForDisplay(entry.filename),
    folder: path && slash > 0 ? path.slice(1, slash) : "",
    openable: entry.exists && entry.uri !== null,
  };
}

export function buildReportModel(state: ImportState): ReportModel {
  const report = state.report;
  const entries = report ? [...report.entries.values()].map((e) => effectiveEntry(state, e)) : [];
  entries.sort((a, b) => a.entryId - b.entryId);
  const finished = report?.summary.state === "finished";

  const failed = entries.filter((e) => e.state === "failed").map((e) => rowOf(e, `f${e.entryId}`));

  const groups = new Map<FindingGroup, FindingRow[]>();
  const renamed: ReportModel["renamed"] = [];
  const seenSettings = new Set<string>();
  for (const entry of entries) {
    if (entry.state === "skipped") continue;
    for (const [index, finding] of entry.findings.entries()) {
      const group = findingGroup(finding.code);
      const row = rowOf(entry, `${entry.entryId}:${index}`);
      if (group === "renamed") {
        renamed.push({ ...row, sentence: findingSentence(finding) });
        continue;
      }
      if (group === "settings") {
        const name = String((finding.params as { name?: unknown }).name ?? "");
        if (seenSettings.has(name)) continue;
        seenSettings.add(name);
      }
      const sentence =
        finding.code === "kept_as_text"
          ? keptAsTextSentence(finding.params as Record<string, unknown>)
          : findingSentence(finding);
      groups.set(group, [...(groups.get(group) ?? []), { ...row, sentence }]);
    }
  }
  const worthALook = WORTH_A_LOOK_ORDER.flatMap((group) => {
    const rows = groups.get(group);
    return rows ? [{ group, rows }] : [];
  });

  // A folder that took another name because its own was in use.
  for (const root of report?.roots ?? []) {
    const path = catalogPathOfUri(root.uri);
    if (!path || root.kind !== "folder") continue;
    const final = path.slice(path.lastIndexOf("/") + 1);
    if (final !== root.name)
      renamed.push({
        key: `root${root.rootId}`,
        name: final,
        sentence: `${root.name}`,
        root: true,
      });
  }

  const skippedEntries = entries.filter((e) => e.state === "skipped");
  const counted = new Map<string, number>();
  const skipped: SkippedLine[] = [];
  for (const entry of skippedEntries) {
    const reason = entry.reason;
    if (reason === "trash" || reason === "hidden" || reason === "unreadable") {
      counted.set(reason, (counted.get(reason) ?? 0) + 1);
    } else {
      skipped.push({
        key: `s${entry.entryId}`,
        line: null,
        name: filenameForDisplay(entry.filename),
        reason,
        count: 1,
      });
    }
  }
  for (const [reason, count] of counted)
    skipped.push({ key: `c${reason}`, line: reason, name: "", reason, count });

  const notImportedEntries = finished ? entries.filter((e) => e.state === "not_imported") : [];
  const notImported: ReportModel["notImported"] = {
    emptyKept: [],
    keptWithWrote: [],
    neverCreated: [],
    deleted: entries.filter((e) => e.state === "deleted").map((e) => rowOf(e, `d${e.entryId}`)),
  };
  for (const entry of notImportedEntries) {
    const row = rowOf(entry, `n${entry.entryId}`);
    if (entry.exists && entry.reason === "edited_before_arrival")
      notImported.keptWithWrote.push(row);
    else if (entry.exists) notImported.emptyKept.push(row);
    else notImported.neverCreated.push(row);
  }

  const areas = report
    ? [...new Set(entries.flatMap((e) => (e.uri ? [e.uri.slice(0, e.uri.indexOf("://"))] : [])))]
    : [];

  return {
    roots: (report?.roots ?? []).map((root) => ({
      rootId: root.rootId,
      kind: root.kind,
      name: root.uri ? (catalogPathOfUri(root.uri)?.split("/").at(-1) ?? root.name) : root.name,
      uri: root.uri ?? null,
      id: root.id || null,
    })),
    areas,
    failed,
    worthALook,
    worthALookCount: worthALook.reduce((sum, group) => sum + group.rows.length, 0),
    renamed,
    skipped,
    skippedCount: skippedEntries.length,
    notImported,
  };
}
