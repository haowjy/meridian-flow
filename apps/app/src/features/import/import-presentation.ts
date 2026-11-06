/** Pure mapping from durable progress and this tab's upload facts to what the Import button and popup show. */
import { plural, t } from "@lingui/core/macro";
import type { ImportScheme, ImportSummary } from "@meridian/contracts";
import { areaLabel, type ImportDestination } from "./destination";
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
  | "refused"
  | "expired";
export function importState(summary: ImportSummary, local: LocalUpload): ImportState {
  if (local.stopAsked) return "stop";
  if (local.phase === "reading" || local.phase === "creating") return "reading";
  if (local.phase === "refused") return "refused";
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
  // With no File handles here, a tab holding the import's lock is the only reason to say so.
  return local.elsewhere ? "elsewhere" : "paused";
}
/** The area an import lands in, and so the section whose Import button carries it. */
export const importScheme = (summary: ImportSummary) =>
  (summary.label.kind === "export"
    ? "manuscript"
    : summary.destination.folderUri.split(":")[0]) as ImportScheme;

/** `running`: the spinner. `needs-writer`: the dot. */
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

/** What an import asks of its Import button; null for a clean result, which needs no reading. */
export function importStatus({ summary, local }: Pick<TrackedImport, "summary" | "local">) {
  const state = importState(summary, local);
  if (local.error) return "needs-writer";
  if (RUNNING.has(state)) return "running";
  return state === "done" && !summary.destination.fellBack ? null : "needs-writer";
}

/** Results the writer has read once the popup closes on them. */
export const READ_ON_CLOSE: ReadonlySet<ImportState> = new Set(["done", "needs-look", "expired"]);

/** What a deleted destination means for this import, in the tense of its state. */
function fallbackNote(state: ImportState): string | undefined {
  switch (state) {
    case "done":
    case "needs-look":
      return t`The destination was deleted. Added at the area root.`;
    case "failed":
      return t`The destination was deleted. Trying again adds it at the area root.`;
    case "stop":
    case "expired":
    case "refused":
      return undefined;
    default:
      return t`The destination was deleted. It will be added at the area root.`;
  }
}
export function importPresentation(summary: ImportSummary, local: LocalUpload) {
  const state = importState(summary, local);
  const { files, received, receivedBytes, bytes, prepared, skipped, failed, organized, needsLook } =
    summary.counts;
  const name =
    summary.label.kind === "files" && files > 0
      ? plural(files, { one: "# file", other: "# files" })
      : summary.label.name;
  const area = areaLabel(
    summary.destination.folderUri.split(":")[0] as ImportDestination["scheme"],
  );
  const progress = bytes
    ? Math.min(100, ((receivedBytes + (local.sendingBytes ?? 0)) / bytes) * 100)
    : 0;
  const count = plural(files, { one: `${received} of # file`, other: `${received} of # files` });
  const rows: Record<
    ImportState,
    { title: string; detail?: string; note?: string; progress?: number | "indeterminate" }
  > = {
    reading: { title: t`Reading ${name}`, progress: "indeterminate" },
    uploading: {
      title: t`Uploading ${name}`,
      detail: count,
      note: t`Keep this tab open until the upload finishes.`,
      progress,
    },
    elsewhere: { title: t`Uploading in another window`, detail: count, progress },
    paused: {
      title: t`Upload paused`,
      // The server already holds the folder rows, which are not files: say "nothing" rather than "0 files".
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
      note: t`You can close this tab.`,
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
      detail: t`Nothing was added. Your files are kept for 7 days so you can try again.`,
    },
    refused: { title: t`Import didn't start`, detail: local.error },
    expired: { title: t`Import discarded`, detail: t`It was waiting for 7 days.` },
  };
  return {
    state,
    ...rows[state],
    fallback: summary.destination.fellBack ? fallbackNote(state) : undefined,
  };
}
