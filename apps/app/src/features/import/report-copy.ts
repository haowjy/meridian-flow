/** The report header's words, by display state. */

import { i18n } from "@lingui/core";
import { plural, t } from "@lingui/core/macro";
import type { ImportCounts, ImportRefusalCode } from "@meridian/contracts";
import { type ImportDisplayState, processed } from "./display-state";
import { refusalSentence } from "./reason-copy";

/** "obsidian-vault", "obsidian-vault and Notes.md", "obsidian-vault and 3 files". */
export function namesSentence(names: readonly string[]): string {
  const [first, ...rest] = names;
  if (!first) return "";
  if (rest.length === 0) return first;
  if (rest.length === 1) return t`${first} and ${rest[0]}`;
  const count = rest.length;
  return plural(count, { one: `${first} and # file`, other: `${first} and # files` });
}

export type ReportHeaderCopy = { title: string; body?: string; note?: string };

export function reportHeader(input: {
  display: ImportDisplayState;
  counts: ImportCounts | null;
  destination: string;
  /** A Meridian export, named by its folder. */
  exportName: string | null;
  names: readonly string[];
  total: number;
  code: ImportRefusalCode | null;
  stopped: boolean;
}): ReportHeaderCopy {
  const { counts } = input;
  const total = i18n.number(counts?.total ?? input.total);
  const done = i18n.number(counts ? processed(counts) : 0);
  const names = namesSentence(input.names);
  switch (input.display) {
    case "preparing":
      return {
        title: plural(counts?.total ?? input.total, {
          one: "Preparing # file",
          other: "Preparing # files",
        }),
      };
    case "importing":
      return { title: t`Importing ${done} of ${total}` };
    case "importing-elsewhere":
      return {
        title: t`Importing ${done} of ${total}`,
        body: t`Another window is sending these files.`,
      };
    case "paused":
      return {
        title: t`Import paused at ${done} of ${total}.`,
        body: t`Files stopped arriving, which happens when the page that started the import closes. Choose ${names} again to send the rest.`,
      };
    case "needs-attention":
      return {
        title: plural(counts?.failed ?? 0, {
          one: "# file didn't import.",
          other: "# files didn't import.",
        }),
      };
    case "didnt-start":
      return { title: t`This import didn't start.`, body: refusalSentence(input.code) };
    case "stopping":
      return { title: t`Stopping import…` };
    case "couldnt-stop":
      return { title: t`Couldn't stop the import.` };
    case "finished": {
      const exported = input.exportName;
      const destination = input.destination;
      return {
        title: exported ? t`Imported ${exported}` : t`Imported into ${destination}`,
        note: input.stopped ? t`Stopped before every file arrived.` : undefined,
      };
    }
  }
}

/** The one paragraph of separate sentences under the roots, each only when non-zero. */
export function summarySentences(counts: ImportCounts): string[] {
  const out: string[] = [];
  if (counts.landed > 0)
    out.push(plural(counts.landed, { one: "# file imported.", other: "# files imported." }));
  if (counts.failed > 0)
    out.push(plural(counts.failed, { one: "# didn't import.", other: "# didn't import." }));
  if (counts.skipped > 0)
    out.push(plural(counts.skipped, { one: "# was skipped.", other: "# were skipped." }));
  if (counts.deleted > 0)
    out.push(
      plural(counts.deleted, {
        one: "# was deleted before it arrived.",
        other: "# were deleted before they arrived.",
      }),
    );
  if (counts.notImported > 0)
    out.push(
      plural(counts.notImported, { one: "# wasn't imported.", other: "# weren't imported." }),
    );
  return out;
}
