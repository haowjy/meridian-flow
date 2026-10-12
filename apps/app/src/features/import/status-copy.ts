/** The words of the status row and the report header, one place so both say the same thing. */
import { i18n } from "@lingui/core";
import { plural, t } from "@lingui/core/macro";
import type { ImportCounts } from "@meridian/contracts";
import { type ImportDisplayState, processed } from "./display-state";

export type StatusLines = {
  line1: string;
  line2?: string;
  /** What the bar shows. */
  bar: "none" | "determinate" | "indeterminate" | "static";
};

export function statusLines(input: {
  display: ImportDisplayState;
  counts: ImportCounts | null;
  /** Files this tab counted before the server did. */
  preparingTotal: number;
  /** Preparing: 0 to 100 of bytes hashed, or null once the plan is out. */
  hashedPercent: number | null;
  stopped: boolean;
  /** Things worth a look, from the loaded report when there is one (the server's count includes renames). */
  worthALook?: number;
}): StatusLines {
  const { display, counts } = input;
  const totalCount = counts?.total ?? input.preparingTotal;
  const total = i18n.number(totalCount);
  const done = i18n.number(counts ? processed(counts) : 0);
  switch (display) {
    case "preparing":
      return {
        line1: plural(totalCount, { one: "Preparing # file", other: "Preparing # files" }),
        bar: input.hashedPercent === null ? "indeterminate" : "determinate",
      };
    case "importing":
      return { line1: t`Importing ${done} of ${total}`, bar: "determinate" };
    case "importing-elsewhere":
      return {
        line1: t`Importing ${done} of ${total}`,
        line2: t`Sending from another window`,
        bar: "determinate",
      };
    case "paused":
      return {
        line1: t`Import paused at ${done} of ${total}`,
        line2: t`Open to continue or stop`,
        bar: "static",
      };
    case "needs-attention": {
      const failed = counts?.failed ?? 0;
      return {
        line1: plural(failed, { one: "# file didn't import", other: "# files didn't import" }),
        line2: t`Open to retry`,
        bar: "none",
      };
    }
    case "didnt-start":
      return { line1: t`Import didn't start`, line2: t`Open to try again`, bar: "none" };
    case "stopping":
      return { line1: t`Stopping import`, bar: "static" };
    case "couldnt-stop":
      return {
        line1: t`Couldn't stop the import`,
        line2: t`Open to try again`,
        bar: "none",
      };
    case "finished": {
      const landedCount = counts?.landed ?? 0;
      const landed = i18n.number(landedCount);
      if (counts && counts.total === 0)
        return { line1: t`Nothing imported`, line2: t`Everything was skipped`, bar: "none" };
      if (counts && landedCount < counts.total)
        return {
          line1: t`Imported ${landed} of ${total} files`,
          line2: t`Open the report to see the rest`,
          bar: "none",
        };
      const findings = input.worthALook ?? counts?.findings ?? 0;
      return {
        line1: plural(landedCount, { one: "Imported # file", other: "Imported # files" }),
        line2:
          findings > 0
            ? plural(findings, { one: "# worth a look", other: "# worth a look" })
            : undefined,
        bar: "none",
      };
    }
  }
}
