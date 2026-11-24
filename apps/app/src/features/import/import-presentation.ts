import { plural, t } from "@lingui/core/macro";
import type { ImportEntryStatus, ImportScheme, ImportSummary } from "@meridian/contracts";
import { addressScheme } from "@meridian/contracts/context-uri";
import { schemeLabel } from "@/features/project/context/context-schemes";
import type { ImportDestination } from "./destination";
import type { LocalUpload, TrackedImport } from "./import-coordinator";

export type ImportState =
  | "reading"
  | "uploading"
  | "elsewhere"
  | "paused"
  | "missing"
  | "wrong-root"
  | "stalled"
  | "stop"
  | "waiting"
  | "organizing"
  | "adding"
  | "done"
  | "needs-look"
  | "failed"
  | "expired";
export function importState(summary: ImportSummary, local: LocalUpload): ImportState {
  if (local.stopAsked) return "stop";
  if (local.phase === "reading" || local.phase === "creating") return "reading";
  if (summary.state === "cancelled") return "expired";
  if (summary.state === "finished") return summary.counts.needsLook ? "needs-look" : "done";
  if (local.stopLost) return "adding";
  if (summary.state === "failed") return "failed";
  if (summary.state === "organizing") {
    if (summary.waiting) return "waiting";
    return summary.counts.prepared +
      summary.counts.organized +
      summary.counts.skipped +
      summary.counts.failed >=
      summary.counts.files
      ? "adding"
      : "organizing";
  }
  if (local.phase === "missing" || local.phase === "wrong-root" || local.phase === "stalled")
    return local.phase;
  if (local.phase === "uploading") return "uploading";
  return local.elsewhere ? "elsewhere" : "paused";
}
export const importScheme = (summary: ImportSummary) =>
  (summary.label.kind === "export"
    ? "manuscript"
    : addressScheme(summary.destination.folderUri)) as ImportScheme;

export type ImportStatus = "running" | "needs-writer";

const RUNNING: ReadonlySet<ImportState> = new Set([
  "reading",
  "uploading",
  "elsewhere",
  "stop",
  "waiting",
  "organizing",
  "adding",
]);

const skipMatters = ({ state, reason }: ImportEntryStatus) =>
  state === "skipped" && reason !== "hidden" && reason !== "trash";

export function importStatus({
  summary,
  local,
  detail,
}: Pick<TrackedImport, "summary" | "local" | "detail">): ImportStatus | null {
  const state = importState(summary, local);
  if (local.error) return "needs-writer";
  if (RUNNING.has(state)) return "running";
  if (state !== "done" || summary.destination.fellBack) return "needs-writer";
  if (summary.counts.skipped === 0) return null;
  if (detail?.state !== "finished") return "running";
  return detail.entries.some(skipMatters) ? "needs-writer" : null;
}

export const READ_ON_CLOSE: ReadonlySet<ImportState> = new Set(["done", "needs-look", "expired"]);

function fallbackNote(state: ImportState): string | undefined {
  return state === "stop" || state === "expired" ? undefined : t`Destination deleted`;
}
export function importPresentation(summary: ImportSummary, local: LocalUpload) {
  const state = importState(summary, local);
  const { files, received, receivedBytes, bytes, prepared, skipped, failed, organized, needsLook } =
    summary.counts;
  const name =
    summary.label.kind === "files" && files > 0
      ? plural(files, { one: "# file", other: "# files" })
      : summary.label.name;
  const area = schemeLabel(
    addressScheme(summary.destination.folderUri) as ImportDestination["scheme"],
  );
  const progress = bytes
    ? Math.min(100, ((receivedBytes + (local.sendingBytes ?? 0)) / bytes) * 100)
    : 0;
  const count = plural(files, { one: `${received} of # file`, other: `${received} of # files` });
  const rows: Record<
    ImportState,
    { title: string; detail?: string; progress?: number | "indeterminate" }
  > = {
    reading: { title: t`Reading ${name}`, progress: "indeterminate" },
    uploading: {
      title: t`Uploading ${name}`,
      detail: count,
      progress,
    },
    elsewhere: { title: t`Uploading in another window`, detail: count, progress },
    paused: {
      title: t`Upload paused`,
      detail: received
        ? t`${count} uploaded. Pick ${name} again to continue.`
        : t`Nothing uploaded yet. Pick ${name} again to continue.`,
      progress,
    },
    missing: {
      title: plural(local.missing?.length ?? 0, {
        one: "# file wasn't in the folder you picked",
        other: "# files weren't in the folder you picked",
      }),
    },
    "wrong-root": {
      title: t`Upload paused`,
      detail: t`Pick the folder named ${name} to continue.`,
    },
    stalled: { title: t`Upload paused`, detail: t`Check your connection.`, progress },
    stop: { title: t`Stop and discard this import?`, detail: t`Nothing from it will be kept.` },
    waiting: {
      title: t`Waiting to organize ${name}`,
      detail: t`Another import in this project is organizing.`,
      progress: "indeterminate",
    },
    organizing: {
      title: t`Organizing ${name}`,
      detail: plural(files, {
        one: `${prepared} of # file ready`,
        other: `${prepared} of # files ready`,
      }),
      progress: files ? ((prepared + skipped + failed) / files) * 100 : 0,
    },
    adding: { title: t`Adding ${name} to ${area}`, progress: 100 },
    done: {
      title: t`Imported ${name}`,
      detail: plural(files, { one: "# file", other: "# files" }),
    },
    "needs-look": {
      title: plural(files, {
        one: `Imported ${organized} of # file`,
        other: `Imported ${organized} of # files`,
      }),
      detail: plural(needsLook, { one: "# needs a look", other: "# need a look" }),
    },
    failed: {
      title: t`Import didn't finish`,
      detail: t`Nothing added`,
    },
    expired: { title: t`Import discarded`, detail: t`Expired` },
  };
  return {
    state,
    ...rows[state],
    fallback: summary.destination.fellBack ? fallbackNote(state) : undefined,
  };
}
